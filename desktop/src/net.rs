use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::Url;

const MAX_REDIRECTS: usize = 5;

#[derive(Debug, thiserror::Error)]
pub enum FetchError {
    #[error("invalid URL: {0}")]
    InvalidUrl(String),
    #[error("unsupported URL scheme")]
    UnsupportedScheme,
    #[error("URL credentials are not allowed")]
    Credentials,
    #[error("destination is not publicly routable")]
    UnsafeDestination,
    #[error("failed to resolve destination: {0}")]
    Resolve(#[source] std::io::Error),
    #[error("failed to build HTTP client: {0}")]
    Client(#[source] reqwest::Error),
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("response exceeded {0} bytes")]
    TooLarge(usize),
    #[error("too many redirects")]
    TooManyRedirects,
    #[error("redirect response did not include a valid location")]
    InvalidRedirect,
}

pub struct FetchedResource {
    pub bytes: Vec<u8>,
}

pub async fn fetch_public_bounded(
    input: &str,
    max_bytes: usize,
    timeout: Duration,
) -> Result<FetchedResource, FetchError> {
    let mut url = Url::parse(input).map_err(|error| FetchError::InvalidUrl(error.to_string()))?;

    for redirect_count in 0..=MAX_REDIRECTS {
        let (host, addresses) = resolve_public_destination(&url).await?;
        let client = reqwest::Client::builder()
            .use_rustls_tls()
            .connect_timeout(Duration::from_secs(10))
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(&host, &addresses)
            .build()
            .map_err(FetchError::Client)?;
        let response = client.get(url.clone()).send().await?;

        if response.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return Err(FetchError::TooManyRedirects);
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(FetchError::InvalidRedirect)?;
            url = url
                .join(location)
                .map_err(|_| FetchError::InvalidRedirect)?;
            continue;
        }

        let response = response.error_for_status()?;
        if response
            .content_length()
            .is_some_and(|length| length > max_bytes as u64)
        {
            return Err(FetchError::TooLarge(max_bytes));
        }

        let mut bytes = Vec::with_capacity(
            response.content_length().unwrap_or(0).min(max_bytes as u64) as usize,
        );
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if bytes.len().saturating_add(chunk.len()) > max_bytes {
                return Err(FetchError::TooLarge(max_bytes));
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok(FetchedResource { bytes });
    }

    Err(FetchError::TooManyRedirects)
}

async fn resolve_public_destination(url: &Url) -> Result<(String, Vec<SocketAddr>), FetchError> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(FetchError::UnsupportedScheme);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(FetchError::Credentials);
    }
    let host = url.host_str().ok_or(FetchError::UnsafeDestination)?;
    let port = url
        .port_or_known_default()
        .ok_or(FetchError::UnsupportedScheme)?;
    let addresses = match host.parse::<IpAddr>() {
        Ok(address) => vec![SocketAddr::new(address, port)],
        Err(_) => tokio::net::lookup_host((host, port))
            .await
            .map_err(FetchError::Resolve)?
            .collect(),
    };
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(FetchError::UnsafeDestination);
    }
    Ok((host.to_string(), addresses))
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    !(address.is_private()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_unspecified()
        || address.is_multicast()
        || address.is_broadcast()
        || a == 0
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 240)
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(address) = address.to_ipv4_mapped() {
        return is_public_ipv4(address);
    }
    let segments = address.segments();
    !(address.is_loopback()
        || address.is_unspecified()
        || address.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_public_destinations() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.1.1",
            "192.168.1.1",
            "::1",
            "fc00::1",
            "fe80::1",
        ] {
            assert!(!is_public_ip(address.parse().unwrap()), "{address}");
        }
    }

    #[test]
    fn accepts_public_destinations() {
        assert!(is_public_ip("1.1.1.1".parse().unwrap()));
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
    }
}

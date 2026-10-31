use mdns_sd::{ServiceDaemon, ServiceInfo};

use super::API_VERSION;

const SERVICE_TYPE: &str = "_limbo._tcp.local.";

/// Announces the companion API on the local network so devices can find Limbo without typing an address.
pub struct Advertiser {
    daemon: ServiceDaemon,
    fullname: String,
}

impl Advertiser {
    pub fn start(instance_id: &str, name: &str, port: u16) -> Result<Self, mdns_sd::Error> {
        let daemon = ServiceDaemon::new()?;
        let host = format!(
            "limbo-{}.local.",
            instance_id.split('-').next().unwrap_or(instance_id)
        );
        let api_version = API_VERSION.to_string();
        let properties = [("id", instance_id), ("api", api_version.as_str())];
        let info = ServiceInfo::new(SERVICE_TYPE, name, &host, "", port, &properties[..])?
            .enable_addr_auto();
        let fullname = info.get_fullname().to_string();
        daemon.register(info)?;
        Ok(Self { daemon, fullname })
    }
}

impl Drop for Advertiser {
    fn drop(&mut self) {
        let _ = self.daemon.unregister(&self.fullname);
        let _ = self.daemon.shutdown();
    }
}

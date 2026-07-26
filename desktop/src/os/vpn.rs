const PREFIX_PATTERNS: &[&str] = &["tun", "tap", "ppp", "wg", "utun"];
const CONTAINS_PATTERNS: &[&str] = &[
    "wireguard",
    "openvpn",
    "nordlynx",
    "proton",
    "mullvad",
    "expressvpn",
    "surfshark",
    "cyberghost",
    "pia",
];

pub fn is_vpn_connected() -> bool {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return false;
    };

    interfaces.iter().any(|iface| {
        if iface.is_loopback() || !iface.ip().is_ipv4() {
            return false;
        }
        let name = iface.name.to_lowercase();
        name_matches_vpn(&name)
    })
}

fn name_matches_vpn(name: &str) -> bool {
    if PREFIX_PATTERNS.iter().any(|p| name.starts_with(p)) {
        return true;
    }
    if CONTAINS_PATTERNS.iter().any(|p| name.contains(p)) {
        return true;
    }
    name.contains("private") && name.contains("internet")
}

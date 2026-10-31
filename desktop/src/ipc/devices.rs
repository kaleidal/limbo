use sabine::SabineWindow;

use crate::api::pairing;

use super::{App, ById, Empty, command, fail};

pub fn attach(window: SabineWindow, app: &App) -> SabineWindow {
    let window = command(window, "devices.list", app, |app, Empty {}| {
        Ok(pairing::devices(app))
    });
    let window = command(window, "devices.startPairing", app, |app, Empty {}| {
        app.api.pairing.open().map_err(fail)
    });
    let window = command(window, "devices.stopPairing", app, |app, Empty {}| {
        app.api.pairing.close();
        Ok(())
    });
    command(window, "devices.unpair", app, |app, ById { id }| {
        pairing::unpair(app, &id).map_err(fail)
    })
}

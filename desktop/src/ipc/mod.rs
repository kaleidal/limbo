mod app;
mod bookmarks;
mod debrid;
mod devices;
mod downloads;
mod library;
mod settings;
mod torrents;

use std::fmt::Display;
use std::future::Future;
use std::sync::Arc;

use sabine::{BridgeError, SabineWindow};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use specta::Type;

use crate::state::AppState;

pub(crate) type App = Arc<AppState>;

#[derive(Deserialize, Type)]
pub(crate) struct Empty {}

#[derive(Deserialize, Type)]
pub(crate) struct ById {
    pub id: String,
}

pub(crate) fn fail(error: impl Display) -> BridgeError {
    BridgeError::new(error.to_string())
}

pub(crate) fn command<Req, Res, F>(
    window: SabineWindow,
    name: &str,
    app: &App,
    handler: F,
) -> SabineWindow
where
    Req: DeserializeOwned + Type,
    Res: serde::Serialize + Type,
    F: Fn(&App, Req) -> Result<Res, BridgeError> + Send + Sync + 'static,
{
    let app = app.clone();
    window.bridge_typed(name, move |request| handler(&app, request))
}

pub(crate) fn task<Req, Res, F, Fut>(
    window: SabineWindow,
    name: &str,
    app: &App,
    handler: F,
) -> SabineWindow
where
    Req: DeserializeOwned + Type,
    Res: serde::Serialize + Type + Send + 'static,
    F: Fn(App, Req) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Res, BridgeError>> + Send + 'static,
{
    let app = app.clone();
    window.bridge_typed_async(name, move |request| {
        let job = app.spawn(handler(app.clone(), request));
        async move { job.await.map_err(fail)? }
    })
}

pub fn attach(window: SabineWindow, app: Arc<AppState>) -> SabineWindow {
    [
        app::attach,
        bookmarks::attach,
        library::attach,
        downloads::attach,
        torrents::attach,
        settings::attach,
        debrid::attach,
        devices::attach,
    ]
    .into_iter()
    .fold(window, |window, attach| attach(window, &app))
}

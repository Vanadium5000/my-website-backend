// src/general.rs
use poem_openapi::{OpenApi, payload::PlainText};

use crate::common::BearerTokenAuthorization;

pub struct GeneralApi {}

#[OpenApi]
impl GeneralApi {
    /// Returns the currently logged in user
    #[oai(path = "/hello", method = "get")]
    async fn hello(&self, auth: BearerTokenAuthorization) -> PlainText<String> {
        PlainText(auth.0.username)
    }
}

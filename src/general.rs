// src/general.rs
use poem_openapi::{OpenApi, payload::Json};

use crate::common::{BearerTokenAuthorization, User};

pub struct GeneralApi {}

#[OpenApi]
impl GeneralApi {
    /// Returns the currently logged in user
    #[oai(path = "/hello", method = "get")]
    async fn hello(&self, auth: BearerTokenAuthorization) -> Json<User> {
        Json(auth.0)
    }
}

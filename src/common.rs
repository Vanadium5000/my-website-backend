// src/common.rs
use hmac::Hmac;
use jwt::VerifyWithKey;
use poem::Request;
use poem_openapi::{Object, SecurityScheme, auth::Bearer};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

pub type ServerKey = Hmac<Sha256>;

#[derive(Debug, Serialize, Deserialize, Object)]
pub struct User {
    pub user_id: i64,
    pub username: String,
    pub is_admin: bool,
}

/// ApiKey authorization
#[derive(SecurityScheme)]
#[oai(ty = "bearer", bearer_format = "JWT", checker = "api_checker")]
pub struct BearerTokenAuthorization(pub User);

pub async fn api_checker(req: &Request, bearer: Bearer) -> Option<User> {
    let server_key = req.data::<ServerKey>().unwrap();
    VerifyWithKey::<User>::verify_with_key(bearer.token.as_str(), server_key).ok()
}

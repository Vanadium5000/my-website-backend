// src/blog.rs
use poem::error::InternalServerError;
use poem::web::Data;
use poem_openapi::{
    ApiResponse, Object, OpenApi,
    payload::{Json, PlainText},
};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::common::BearerTokenAuthorization;
/// Blog
#[derive(Debug, Serialize, Deserialize, Object)]
struct Blog {
    post_id: i64,
    title: String,
    content: String,
    snippet: String,
    likes: i64,
    dislikes: i64,
    created_at: String,
}

/// Blog ID
#[derive(Object)]
struct BlogGetRequest {
    post_id: i64,
}

#[derive(ApiResponse)]
enum BlogGetResponse {
    /// Found
    #[oai(status = 200)]
    Ok(Json<Blog>),
    /// Not found
    #[oai(status = 404)]
    NotFound(PlainText<String>),
}

/// Blog ID & comment content
#[derive(Object)]
struct BlogCommentRequest {
    post_id: i64,
    content: String,
}

/// Gets the user's reactions to post & returns (has_liked, has_disliked)
async fn user_reaction(
    pool: &Data<&SqlitePool>,
    user_id: i64,
    post_id: i64,
) -> Result<(bool, bool), poem::Error> {
    // Check existing reaction
    let is_like = sqlx::query_scalar!(
        "SELECT is_like FROM user_reactions WHERE user_id = ? AND post_id = ?",
        user_id,
        post_id
    )
    .fetch_optional(pool.0)
    .await
    .map_err(InternalServerError)?;

    match is_like {
        Some(is_like) => Ok((is_like, !is_like)),
        None => Ok((false, false)),
    }
}

pub struct BlogApi {}

#[OpenApi]
impl BlogApi {
    /// Returns all publicly available blog posts
    #[oai(path = "/posts", method = "get")]
    async fn get_all(&self, pool: Data<&SqlitePool>) -> Result<Json<Vec<Blog>>, poem::Error> {
        // Fetch all blogs/posts
        let posts = sqlx::query_as!(
            Blog,
            "SELECT post_id, title, content, snippet, likes, dislikes, created_at FROM blog_posts"
        )
        .fetch_all(pool.0)
        .await
        .map_err(InternalServerError)?; // Return InternalServerError if sqlx errors
        Ok(Json(posts))
    }

    /// Returns blog post with same post_id
    #[oai(path = "/post", method = "post")]
    async fn get(
        &self,
        pool: Data<&SqlitePool>,
        req: Json<BlogGetRequest>,
    ) -> Result<BlogGetResponse, poem::Error> {
        // Fetch blog/post with same post_id
        let post = sqlx::query_as!(
            Blog,
            "SELECT post_id, title, content, snippet, likes, dislikes, created_at FROM blog_posts WHERE post_id = ?",
            req.0.post_id
        )
        .fetch_optional(pool.0)
        .await
        .map_err(InternalServerError)?; // Return InternalServerError if sqlx errors

        // Check if blog/post exists, error if not
        match post {
            // If post is none, return a not found error
            None => {
                return Ok(BlogGetResponse::NotFound(PlainText(
                    "blog not found".to_string(),
                )));
            }
            // If post exists, return it in Json
            Some(post) => Ok(BlogGetResponse::Ok(Json(post))),
        }
    }

    /// Returns the authenticated user's reaction to the post with the inputted ID
    #[oai(path = "/post_reaction", method = "post")]
    async fn post_reaction(
        &self,
        pool: Data<&SqlitePool>,
        auth: BearerTokenAuthorization,
        req: Json<BlogGetRequest>,
    ) -> Result<Json<Vec<bool>>, poem::Error> {
        let reaction = user_reaction(&pool, auth.0.user_id, req.0.post_id).await?;

        return Ok(Json(vec![reaction.0, reaction.1]));
    }

    /// Like the post if not already liked, unlike the post if, and remove any dislikes
    #[oai(path = "/post_like", method = "post")]
    async fn like(
        &self,
        pool: Data<&SqlitePool>,
        auth: BearerTokenAuthorization,
        req: Json<BlogGetRequest>,
    ) -> Result<PlainText<String>, poem::Error> {
        let reaction = user_reaction(&pool, auth.0.user_id, req.0.post_id).await?;
        let like_difference = if reaction.0 { -1 } else { 1 };
        let dislike_difference = if reaction.1 { -1 } else { 0 };
        let is_now_like = !reaction.0;

        // Increment or decrease blog's like count
        sqlx::query!(
            "UPDATE blog_posts SET likes = likes + ?, dislikes = dislikes + ? WHERE post_id = ?",
            like_difference,
            dislike_difference,
            req.0.post_id
        )
        .execute(pool.0)
        .await
        .map_err(InternalServerError)?; // Return InternalServerError if sqlx errors

        if is_now_like {
            sqlx::query!(
                "INSERT INTO user_reactions (user_id, post_id, is_like) VALUES (?, ?, true) ON CONFLICT(user_id, post_id) DO UPDATE SET is_like = true;",
                auth.0.user_id,
                req.0.post_id
            )
             .execute(pool.0)
        .await
        .map_err(InternalServerError)?; // Return InternalServerError if sqlx errors
        } else {
            sqlx::query!(
                "DELETE FROM user_reactions WHERE user_id = ? AND post_id = ?;",
                auth.0.user_id,
                req.0.post_id
            )
            .execute(pool.0)
            .await
            .map_err(InternalServerError)?; // Return InternalServerError if sqlx errors
        }

        return Ok(PlainText("success".to_string()));
    }

    /// Comment on a post
    #[oai(path = "/post_dislike", method = "post")]
    async fn comment(
        &self,
        pool: Data<&SqlitePool>,
        auth: BearerTokenAuthorization,
        req: Json<BlogGetRequest>,
    ) -> Result<PlainText<String>, poem::Error> {
        let reaction = user_reaction(&pool, auth.0.user_id, req.0.post_id).await?;
        let like_difference = if reaction.0 { -1 } else { 0 };
        let dislike_difference = if reaction.1 { -1 } else { 1 };
        let is_now_dislike = !reaction.1;

        // Increment or decrease blog's like count
        sqlx::query!(
            "UPDATE blog_posts SET likes = likes + ?, dislikes = dislikes + ? WHERE post_id = ?",
            like_difference,
            dislike_difference,
            req.0.post_id
        )
        .execute(pool.0)
        .await
        .map_err(InternalServerError)?; // Return InternalServerError if sqlx errors

        if is_now_dislike {
            sqlx::query!(
                "INSERT INTO user_reactions (user_id, post_id, is_like) VALUES (?, ?, false) ON CONFLICT(user_id, post_id) DO UPDATE SET is_like = false;",
                auth.0.user_id,
                req.0.post_id
            )
             .execute(pool.0)
        .await
        .map_err(InternalServerError)?; // Return InternalServerError if sqlx errors
        } else {
            sqlx::query!(
                "DELETE FROM user_reactions WHERE user_id = ? AND post_id = ?;",
                auth.0.user_id,
                req.0.post_id
            )
            .execute(pool.0)
            .await
            .map_err(InternalServerError)?; // Return InternalServerError if sqlx errors
        }

        return Ok(PlainText("success".to_string()));
    }

    /// Dislike the post if not already disliked, undislike the post if, and remove any likes
    #[oai(path = "/post_dislike", method = "post")]
    async fn dislike(
        &self,
        pool: Data<&SqlitePool>,
        auth: BearerTokenAuthorization,
        req: Json<BlogGetRequest>,
    ) -> Result<PlainText<String>, poem::Error> {
        let reaction = user_reaction(&pool, auth.0.user_id, req.0.post_id).await?;
        let like_difference = if reaction.0 { -1 } else { 0 };
        let dislike_difference = if reaction.1 { -1 } else { 1 };
        let is_now_dislike = !reaction.1;

        // Increment or decrease blog's like count
        sqlx::query!(
            "UPDATE blog_posts SET likes = likes + ?, dislikes = dislikes + ? WHERE post_id = ?",
            like_difference,
            dislike_difference,
            req.0.post_id
        )
        .execute(pool.0)
        .await
        .map_err(InternalServerError)?; // Return InternalServerError if sqlx errors

        if is_now_dislike {
            sqlx::query!(
                "INSERT INTO user_reactions (user_id, post_id, is_like) VALUES (?, ?, false) ON CONFLICT(user_id, post_id) DO UPDATE SET is_like = false;",
                auth.0.user_id,
                req.0.post_id
            )
             .execute(pool.0)
        .await
        .map_err(InternalServerError)?; // Return InternalServerError if sqlx errors
        } else {
            sqlx::query!(
                "DELETE FROM user_reactions WHERE user_id = ? AND post_id = ?;",
                auth.0.user_id,
                req.0.post_id
            )
            .execute(pool.0)
            .await
            .map_err(InternalServerError)?; // Return InternalServerError if sqlx errors
        }

        return Ok(PlainText("success".to_string()));
    }
}

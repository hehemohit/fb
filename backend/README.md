# Backend (Facebook Graph API for Pages)

## Setup

Create ackend/.env with:

`
PORT=4000
MONGO_URI=mongodb://localhost:27017/mern_facebook
FB_APP_ID=YOUR_APP_ID
FB_APP_SECRET=YOUR_APP_SECRET
FB_REDIRECT_URI=http://localhost:4000/auth/facebook/callback
JWT_SECRET=replace_with_strong_secret
`

Start MongoDB, then:

`
npm install
npm run dev
`

## Endpoints

- GET /auth/facebook
- GET /auth/facebook/callback
- GET /api/pages
- POST /api/pages/save
- POST /api/post/text
- POST /api/post/photo

### Insights
- GET /api/insights/page?pageId=...&since=YYYY-MM-DD&until=YYYY-MM-DD&metrics=csv&period=day|week|days_28|lifetime
  - defaults: metrics=`page_impressions,page_impressions_unique,page_engaged_users,page_content_activity,page_fans,page_views_total`, period=`day`
- GET /api/insights/posts?pageId=...&limit=10&metrics=csv&after=...&before=...
  - defaults: metrics=`post_impressions,post_impressions_unique,post_engaged_users,post_clicks,post_reactions_by_type_total`
- GET /api/insights/post?postId=...&pageId=...&metrics=csv
  - defaults: metrics=`post_impressions,post_impressions_unique,post_engaged_users,post_clicks,post_reactions_by_type_total,post_video_views`

### Instagram (requires IG Business/Creator linked to the Page)
- GET /api/ig/account?pagesId=... → returns `{ igUserId, username }`
- POST /api/ig/photo { pageId, imageUrl, caption }
- POST /api/ig/video { pageId, videoUrl, caption, shareToFeed }

CORS is configured for http://localhost:5173.

## Notes

- Use PAGE access tokens for Page posts.
- Do not expose PAGE tokens to the frontend.
 
### Instagram Requirements
- Instagram account must be Business or Creator.
- It must be linked to the Facebook Page in Page settings.
- App permissions (during login/App Review): `instagram_basic`, `instagram_content_publish`, `pages_show_list`.
- Publishing flow: create container via `/{ig-user-id}/media` then publish with `/{ig-user-id}/media_publish`.

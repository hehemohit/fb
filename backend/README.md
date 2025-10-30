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

CORS is configured for http://localhost:5173.

## Notes

- Use PAGE access tokens for Page posts.
- Do not expose PAGE tokens to the frontend.

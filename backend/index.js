require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const PageToken = require('./models/PageToken');

const app = express();
app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Connect to MongoDB
mongoose.set('strictQuery', true);
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }));

// Step A: redirect user to FB Login (request scopes)
app.get('/auth/facebook', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.FB_APP_ID,
    redirect_uri: process.env.FB_REDIRECT_URI,
    scope:
      'pages_manage_posts,pages_read_engagement,pages_show_list,pages_manage_metadata',
    response_type: 'code',
    auth_type: 'rerequest',
  });
  res.redirect(`https://www.facebook.com/v20.0/dialog/oauth?${params.toString()}`);
});

// Step B: handle callback → exchange code for USER access token
app.get('/auth/facebook/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Missing code' });
  try {
    const tokenResp = await axios.get(
      'https://graph.facebook.com/v20.0/oauth/access_token',
      {
        params: {
          client_id: process.env.FB_APP_ID,
          client_secret: process.env.FB_APP_SECRET,
          redirect_uri: process.env.FB_REDIRECT_URI,
          code,
        },
      }
    );
    const userAccessToken = tokenResp.data.access_token;

    // Optional: exchange for long-lived USER token
    const longLivedResp = await axios.get(
      'https://graph.facebook.com/v20.0/oauth/access_token',
      {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: process.env.FB_APP_ID,
          client_secret: process.env.FB_APP_SECRET,
          fb_exchange_token: userAccessToken,
        },
      }
    );
    const longLivedUserToken = longLivedResp.data.access_token;

    // Stash user token in a short-lived session JWT
    const jwtToken = jwt.sign(
      { userToken: longLivedUserToken },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    res.cookie('session', jwtToken, { httpOnly: true, sameSite: 'lax' });

    // Redirect frontend to page selection UI
    res.redirect('http://localhost:5173/select-page');
  } catch (e) {
    const err = e.response?.data || e.message;
    console.error('OAuth callback error:', err);
    res.status(400).json({ error: err });
  }
});

// List pages (frontend calls this to let the user pick a Page)
app.get('/api/pages', async (req, res) => {
  try {
    const jwtToken = req.cookies.session;
    if (!jwtToken) return res.status(401).json({ error: 'Unauthorized' });
    const { userToken } = jwt.verify(jwtToken, process.env.JWT_SECRET);
    const pagesResp = await axios.get('https://graph.facebook.com/v20.0/me/accounts', {
      params: { access_token: userToken },
    });
    res.json(pagesResp.data.data);
  } catch (e) {
    res.status(401).json({ error: 'Unauthorized' });
  }
});

// Save selected page + PAGE token
app.post('/api/pages/save', async (req, res) => {
  try {
    const { pageId, pageName, pageAccessToken, ownerUserId } = req.body || {};
    if (!pageId || !pageAccessToken)
      return res.status(400).json({ error: 'Missing pageId or pageAccessToken' });

    await PageToken.findOneAndUpdate(
      { pageId },
      { pageName, accessToken: pageAccessToken, ownerUserId },
      { upsert: true, new: true }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Create a text/link post: POST /{page-id}/feed
app.post('/api/post/text', async (req, res) => {
  try {
    const { pageId, message, link } = req.body || {};
    if (!pageId || !message) return res.status(400).json({ error: 'Missing data' });
    const page = await PageToken.findOne({ pageId });
    if (!page) return res.status(404).json({ error: 'Page not saved' });

    const params = { message, access_token: page.accessToken };
    if (link) params.link = link;

    const fbResp = await axios.post(
      `https://graph.facebook.com/v20.0/${pageId}/feed`,
      null,
      { params }
    );
    res.json(fbResp.data);
  } catch (e) {
    const err = e.response?.data || e.message;
    console.error('Create text post error:', err);
    res.status(400).json({ error: err });
  }
});

// Create a photo post: POST /{page-id}/photos
app.post('/api/post/photo', async (req, res) => {
  try {
    const { pageId, message, imageUrl } = req.body || {};
    if (!pageId || !imageUrl) return res.status(400).json({ error: 'Missing data' });
    const page = await PageToken.findOne({ pageId });
    if (!page) return res.status(404).json({ error: 'Page not saved' });

    const params = {
      url: imageUrl,
      caption: message,
      access_token: page.accessToken,
      published: true,
    };
    const fbResp = await axios.post(
      `https://graph.facebook.com/v20.0/${pageId}/photos`,
      null,
      { params }
    );
    res.json(fbResp.data);
  } catch (e) {
    const err = e.response?.data || e.message;
    console.error('Create photo post error:', err);
    res.status(400).json({ error: err });
  }
});

// Start server
const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`API on :${port}`));



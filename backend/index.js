require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const FormData = require('form-data');
const upload = multer({ storage: multer.memoryStorage() });
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
    const { pageId, message, link, scheduledPublishTime, publishNow } = req.body || {};
    if (!pageId || !message) return res.status(400).json({ error: 'Missing data' });
    const page = await PageToken.findOne({ pageId });
    if (!page) return res.status(404).json({ error: 'Page not saved' });

    const params = { message, access_token: page.accessToken };
    if (link) params.link = link;
    // Scheduling: if scheduledPublishTime provided, create an unpublished scheduled post
    if (scheduledPublishTime) {
      params.published = false;
      params.scheduled_publish_time = Number(scheduledPublishTime);
    } else if (publishNow === false) {
      params.published = false;
    }

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
    const { pageId, message, imageUrl, altText, scheduledPublishTime, publishNow } = req.body || {};
    if (!pageId || !imageUrl) return res.status(400).json({ error: 'Missing data' });
    const page = await PageToken.findOne({ pageId });
    if (!page) return res.status(404).json({ error: 'Page not saved' });

    const params = {
      url: imageUrl,
      caption: message,
      access_token: page.accessToken,
      published: true,
    };
    if (altText) params.alt_text_custom = altText;
    if (scheduledPublishTime) {
      params.published = false;
      params.scheduled_publish_time = Number(scheduledPublishTime);
    } else if (publishNow === false) {
      params.published = false;
    }
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

// Upload a local image file and post as photo (multipart)
app.post('/api/post/photo-upload', upload.single('file'), async (req, res) => {
  try {
    const { pageId, message } = req.body || {};
    const file = req.file;
    if (!pageId || !file) return res.status(400).json({ error: 'Missing pageId or file' });
    const page = await PageToken.findOne({ pageId });
    if (!page) return res.status(404).json({ error: 'Page not saved' });

    const form = new FormData();
    form.append('caption', message || '');
    form.append('access_token', page.accessToken);
    form.append('published', 'true');
    form.append('source', file.buffer, { filename: file.originalname, contentType: file.mimetype });

    const fbResp = await axios.post(`https://graph.facebook.com/v20.0/${pageId}/photos`, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    res.json(fbResp.data);
  } catch (e) {
    const err = e.response?.data || e.message;
    console.error('Photo upload error:', err);
    res.status(400).json({ error: err });
  }
});

// Compose: post message with multiple images (URLs and/or uploaded files) in one post
app.post('/api/post/compose', upload.array('files'), async (req, res) => {
  try {
    const { pageId } = req.body || {};
    let { message, imageUrls } = req.body || {};
    const files = req.files || [];
    if (!pageId) return res.status(400).json({ error: 'Missing pageId' });
    const page = await PageToken.findOne({ pageId });
    if (!page) return res.status(404).json({ error: 'Page not saved' });

    if (typeof imageUrls === 'string') {
      try { imageUrls = JSON.parse(imageUrls || '[]'); } catch { imageUrls = []; }
    }
    if (!Array.isArray(imageUrls)) imageUrls = [];

    const mediaIds = [];

    // 1) Upload URL images as unpublished to get media_fbid
    if (imageUrls.length) {
      const urlUploads = await Promise.all(
        imageUrls.map((u) =>
          axios.post(`https://graph.facebook.com/v20.0/${pageId}/photos`, null, {
            params: { url: u, published: false, access_token: page.accessToken },
          })
        )
      );
      urlUploads.forEach((r) => mediaIds.push(r.data.id));
    }

    // 2) Upload local files as unpublished to get media_fbid
    for (const file of files) {
      const form = new FormData();
      form.append('published', 'false');
      form.append('access_token', page.accessToken);
      form.append('source', file.buffer, { filename: file.originalname, contentType: file.mimetype });
      const up = await axios.post(`https://graph.facebook.com/v20.0/${pageId}/photos`, form, { headers: form.getHeaders() });
      mediaIds.push(up.data.id);
    }

    if (mediaIds.length === 0 && !message) {
      return res.status(400).json({ error: 'Nothing to post' });
    }

    // 3) Create feed post with attached_media
    const attached_media = mediaIds.map((id) => ({ media_fbid: id }));
    const fbResp = await axios.post(`https://graph.facebook.com/v20.0/${pageId}/feed`, null, {
      params: { message: message || '', attached_media, access_token: page.accessToken },
    });
    res.json(fbResp.data);
  } catch (e) {
    const err = e.response?.data || e.message;
    console.error('Compose post error:', err);
    res.status(400).json({ error: err });
  }
});

// Create a multi-photo post by attaching multiple media
app.post('/api/post/photos-multi', async (req, res) => {
  try {
    const { pageId, message, imageUrls = [] } = req.body || {};
    if (!pageId || !Array.isArray(imageUrls) || imageUrls.length === 0) {
      return res.status(400).json({ error: 'Missing imageUrls' });
    }
    const page = await PageToken.findOne({ pageId });
    if (!page) return res.status(404).json({ error: 'Page not saved' });

    // Upload each photo as unpublished to get media_fbid
    const uploadPromises = imageUrls.map((u) =>
      axios.post(`https://graph.facebook.com/v20.0/${pageId}/photos`, null, {
        params: { url: u, published: false, access_token: page.accessToken },
      })
    );
    const uploads = await Promise.all(uploadPromises);
    const attached_media = uploads.map((r) => ({ media_fbid: r.data.id }));

    const fbResp = await axios.post(`https://graph.facebook.com/v20.0/${pageId}/feed`, null, {
      params: {
        message: message || '',
        attached_media,
        access_token: page.accessToken,
      },
    });
    res.json(fbResp.data);
  } catch (e) {
    const err = e.response?.data || e.message;
    console.error('Multi-photo post error:', err);
    res.status(400).json({ error: err });
  }
});

// Create a video post from a public video file URL
app.post('/api/post/video', async (req, res) => {
  try {
    const { pageId, fileUrl, title, description, published = true, scheduledPublishTime } = req.body || {};
    if (!pageId || !fileUrl) return res.status(400).json({ error: 'Missing data' });
    const page = await PageToken.findOne({ pageId });
    if (!page) return res.status(404).json({ error: 'Page not saved' });

    const params = {
      file_url: fileUrl,
      title: title || undefined,
      description: description || undefined,
      access_token: page.accessToken,
      published: Boolean(published),
    };
    if (scheduledPublishTime) {
      params.published = false;
      params.scheduled_publish_time = Number(scheduledPublishTime);
    }
    const fbResp = await axios.post(`https://graph.facebook.com/v20.0/${pageId}/videos`, null, { params });
    res.json(fbResp.data);
  } catch (e) {
    const err = e.response?.data || e.message;
    console.error('Video post error:', err);
    res.status(400).json({ error: err });
  }
});

// List recent posts to enable edit/delete
app.get('/api/posts', async (req, res) => {
  try {
    const { pageId, limit = 10 } = req.query || {};
    if (!pageId) return res.status(400).json({ error: 'Missing pageId' });
    const page = await PageToken.findOne({ pageId });
    if (!page) return res.status(404).json({ error: 'Page not saved' });
    const fbResp = await axios.get(`https://graph.facebook.com/v20.0/${pageId}/posts`, {
      params: {
        fields: 'id,message,created_time,permalink_url,is_hidden,attachments{media_type,media,url}',
        limit: Number(limit),
        access_token: page.accessToken,
      },
    });
    res.json(fbResp.data);
  } catch (e) {
    res.status(400).json({ error: e.response?.data || e.message });
  }
});

// Edit a post's message
app.post('/api/post/edit', async (req, res) => {
  try {
    const { pageId, postId, message } = req.body || {};
    if (!pageId || !postId || !message) return res.status(400).json({ error: 'Missing data' });
    const page = await PageToken.findOne({ pageId });
    if (!page) return res.status(404).json({ error: 'Page not saved' });
    const fbResp = await axios.post(`https://graph.facebook.com/v20.0/${postId}`, null, {
      params: { message, access_token: page.accessToken },
    });
    res.json(fbResp.data);
  } catch (e) {
    res.status(400).json({ error: e.response?.data || e.message });
  }
});

// Hide/unhide a post
app.post('/api/post/hide', async (req, res) => {
  try {
    const { pageId, postId, isHidden } = req.body || {};
    if (!pageId || !postId) return res.status(400).json({ error: 'Missing data' });
    const page = await PageToken.findOne({ pageId });
    if (!page) return res.status(404).json({ error: 'Page not saved' });
    const fbResp = await axios.post(`https://graph.facebook.com/v20.0/${postId}`, null, {
      params: { is_hidden: Boolean(isHidden), access_token: page.accessToken },
    });
    res.json(fbResp.data);
  } catch (e) {
    res.status(400).json({ error: e.response?.data || e.message });
  }
});

// Delete a post
app.delete('/api/post', async (req, res) => {
  try {
    const { pageId, postId } = req.query || {};
    if (!pageId || !postId) return res.status(400).json({ error: 'Missing data' });
    const page = await PageToken.findOne({ pageId });
    if (!page) return res.status(404).json({ error: 'Page not saved' });
    const fbResp = await axios.delete(`https://graph.facebook.com/v20.0/${postId}`, {
      params: { access_token: page.accessToken },
    });
    res.json(fbResp.data);
  } catch (e) {
    res.status(400).json({ error: e.response?.data || e.message });
  }
});
// Instagram: get IG user id linked to a Page
app.get('/api/ig/account', async (req, res) => {
  try {
    const { pageId } = req.query || {};
    if (!pageId) return res.status(400).json({ error: 'Missing pageId' });
    const page = await PageToken.findOne({ pageId });
    if (!page) return res.status(404).json({ error: 'Page not saved' });

    const igResp = await axios.get(`https://graph.facebook.com/v20.0/${pageId}`, {
      params: {
        fields: 'instagram_business_account{username,id}',
        access_token: page.accessToken,
      },
    });
    const ig = igResp.data.instagram_business_account;
    if (!ig) return res.json({ igUserId: null, username: null });
    res.json({ igUserId: ig.id, username: ig.username });
  } catch (e) {
    const err = e.response?.data || e.message;
    res.status(400).json({ error: err });
  }
});

// Instagram: post a photo (image URL) via container + publish
app.post('/api/ig/photo', async (req, res) => {
  try {
    const { pageId, imageUrl, caption } = req.body || {};
    if (!pageId || !imageUrl) return res.status(400).json({ error: 'Missing data' });
    const page = await PageToken.findOne({ pageId });
    if (!page) return res.status(404).json({ error: 'Page not saved' });

    // find IG user
    const igResp = await axios.get(`https://graph.facebook.com/v20.0/${pageId}`, {
      params: {
        fields: 'instagram_business_account{id}',
        access_token: page.accessToken,
      },
    });
    const igUserId = igResp.data?.instagram_business_account?.id;
    if (!igUserId) return res.status(400).json({ error: 'No IG account linked to this Page' });

    // 1) create media container
    const container = await axios.post(
      `https://graph.facebook.com/v20.0/${igUserId}/media`,
      null,
      {
        params: {
          image_url: imageUrl,
          caption: caption || '',
          access_token: page.accessToken,
        },
      }
    );

    // 2) publish container
    const publish = await axios.post(
      `https://graph.facebook.com/v20.0/${igUserId}/media_publish`,
      null,
      {
        params: {
          creation_id: container.data.id,
          access_token: page.accessToken,
        },
      }
    );

    res.json({ creation_id: container.data.id, id: publish.data.id });
  } catch (e) {
    const err = e.response?.data || e.message;
    console.error('IG photo post error:', err);
    res.status(400).json({ error: err });
  }
});

// Instagram: post a video (Reel) via video_url
app.post('/api/ig/video', async (req, res) => {
  try {
    const { pageId, videoUrl, caption, shareToFeed } = req.body || {};
    if (!pageId || !videoUrl) return res.status(400).json({ error: 'Missing data' });
    const page = await PageToken.findOne({ pageId });
    if (!page) return res.status(404).json({ error: 'Page not saved' });

    const igResp = await axios.get(`https://graph.facebook.com/v20.0/${pageId}`, {
      params: {
        fields: 'instagram_business_account{id}',
        access_token: page.accessToken,
      },
    });
    const igUserId = igResp.data?.instagram_business_account?.id;
    if (!igUserId) return res.status(400).json({ error: 'No IG account linked to this Page' });

    const container = await axios.post(
      `https://graph.facebook.com/v20.0/${igUserId}/media`,
      null,
      {
        params: {
          media_type: 'VIDEO',
          video_url: videoUrl,
          caption: caption || '',
          share_to_feed: Boolean(shareToFeed),
          access_token: page.accessToken,
        },
      }
    );

    const publish = await axios.post(
      `https://graph.facebook.com/v20.0/${igUserId}/media_publish`,
      null,
      {
        params: {
          creation_id: container.data.id,
          access_token: page.accessToken,
        },
      }
    );

    res.json({ creation_id: container.data.id, id: publish.data.id });
  } catch (e) {
    const err = e.response?.data || e.message;
    console.error('IG video post error:', err);
    res.status(400).json({ error: err });
  }
});

// Start server
const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`API on :${port}`));



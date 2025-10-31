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

// Validate scheduled publish time (unix seconds) per FB rules
function validateScheduledUnix(scheduledUnix) {
  const now = Math.floor(Date.now() / 1000);
  const min = now + 10 * 60; // 10 minutes ahead
  const max = now + 75 * 24 * 60 * 60; // ~75 days
  if (!scheduledUnix) return { ok: false, reason: 'missing' };
  const n = Number(scheduledUnix);
  if (!Number.isFinite(n)) return { ok: false, reason: 'nan' };
  if (n < min) return { ok: false, reason: 'tooSoon', min };
  if (n > max) return { ok: false, reason: 'tooLate', max };
  return { ok: true, value: Math.floor(n) };
}

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
      const chk = validateScheduledUnix(scheduledPublishTime);
      if (!chk.ok) return res.status(400).json({ error: 'Invalid scheduledPublishTime' });
      params.published = false;
      params.scheduled_publish_time = chk.value;
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
      const chk = validateScheduledUnix(scheduledPublishTime);
      if (!chk.ok) return res.status(400).json({ error: 'Invalid scheduledPublishTime' });
      params.published = false;
      params.scheduled_publish_time = chk.value;
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
    const { pageId, message, scheduledPublishTime, publishNow } = req.body || {};
    const file = req.file;
    if (!pageId || !file) return res.status(400).json({ error: 'Missing pageId or file' });
    const page = await PageToken.findOne({ pageId });
    if (!page) return res.status(404).json({ error: 'Page not saved' });

    const form = new FormData();
    form.append('caption', message || '');
    form.append('access_token', page.accessToken);
    // Scheduling rules: when provided, post must be unpublished with future unix timestamp
    if (scheduledPublishTime) {
      const chk = validateScheduledUnix(scheduledPublishTime);
      if (!chk.ok) return res.status(400).json({ error: 'Invalid scheduledPublishTime' });
      form.append('published', 'false');
      form.append('scheduled_publish_time', String(chk.value));
    } else if (String(publishNow) === 'false') {
      form.append('published', 'false');
    } else {
      form.append('published', 'true');
    }
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
    let { message, imageUrls, link, scheduledPublishTime, publishNow } = req.body || {};
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
    const params = { message: message || '', access_token: page.accessToken };
    if (mediaIds.length > 0) {
      params.attached_media = mediaIds.map((id) => ({ media_fbid: id }));
    } else if (link) {
      params.link = link;
    }
    if (scheduledPublishTime) {
      const chk = validateScheduledUnix(scheduledPublishTime);
      if (!chk.ok) return res.status(400).json({ error: 'Invalid scheduledPublishTime' });
      params.published = false;
      params.scheduled_publish_time = chk.value;
    } else if (String(publishNow) === 'false') {
      params.published = false;
    }
    const fbResp = await axios.post(`https://graph.facebook.com/v20.0/${pageId}/feed`, null, { params });
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
      const chk = validateScheduledUnix(scheduledPublishTime);
      if (!chk.ok) return res.status(400).json({ error: 'Invalid scheduledPublishTime' });
      params.published = false;
      params.scheduled_publish_time = chk.value;
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

// Page-level insights summary
app.get('/api/insights/page', async (req, res) => {
  try {
    const { pageId, since, until, metrics, period } = req.query || {};
    if (!pageId) return res.status(400).json({ error: 'Missing pageId' });
    const page = await PageToken.findOne({ pageId });
    if (!page) return res.status(404).json({ error: 'Page not saved' });

    const lifetimeOnly = new Set([
      'page_fans',
      'page_fans_city',
      'page_fans_locale',
      'page_fans_gender_age',
    ]);
    const defaultPeriod = period || 'day';
    // Choose safe defaults for the requested period
    const defaultMetrics = defaultPeriod === 'lifetime'
      ? ['page_fans'].join(',')
      : [
          'page_impressions',
          'page_impressions_unique',
          'page_engaged_users',
          'page_content_activity',
          'page_views_total',
        ].join(',');

    const params = {
      metric: (metrics || defaultMetrics)
        .split(',')
        .map((m) => m.trim())
        .filter((m) => m)
        // Remove lifetime-only metrics when not querying lifetime
        .filter((m) => (defaultPeriod === 'lifetime' ? true : !lifetimeOnly.has(m)))
        .join(','),
      access_token: page.accessToken,
      period: defaultPeriod,
    };
    if (since) params.since = since;
    if (until) params.until = until;

    const resp = await axios.get(`https://graph.facebook.com/v20.0/${pageId}/insights`, { params });
    res.json(resp.data);
  } catch (e) {
    res.status(400).json({ error: e.response?.data || e.message });
  }
});

// Recent posts + per-post key insights
app.get('/api/insights/posts', async (req, res) => {
  try {
    const { pageId, limit = 10, metrics, after, before } = req.query || {};
    if (!pageId) return res.status(400).json({ error: 'Missing pageId' });
    const page = await PageToken.findOne({ pageId });
    if (!page) return res.status(404).json({ error: 'Page not saved' });

    const postsResp = await axios.get(`https://graph.facebook.com/v20.0/${pageId}/posts`, {
      params: {
        fields: 'id,message,created_time,permalink_url',
        limit: Number(limit),
        access_token: page.accessToken,
        after: after || undefined,
        before: before || undefined,
      },
    });
    const posts = postsResp.data?.data || [];
    const paging = postsResp.data?.paging || null;
    if (!posts.length) return res.json({ data: [] });

    const defaultMetrics = [
      'post_impressions',
      'post_impressions_unique',
      'post_engaged_users',
      'post_clicks',
      'post_reactions_by_type_total',
    ].join(',');

    const insightsAll = await Promise.all(
      posts.map((p) =>
        axios
          .get(`https://graph.facebook.com/v20.0/${p.id}/insights`, {
            params: { metric: metrics || defaultMetrics, access_token: page.accessToken },
          })
          .then((r) => ({ id: p.id, insights: r.data?.data || [] }))
          .catch(() => ({ id: p.id, insights: [] }))
      )
    );

    const map = new Map(insightsAll.map((x) => [x.id, x.insights]));
    const merged = posts.map((p) => ({
      ...p,
      insights: map.get(p.id) || [],
    }));

    res.json({ data: merged, paging });
  } catch (e) {
    res.status(400).json({ error: e.response?.data || e.message });
  }
});

// Detailed insights for a single post
app.get('/api/insights/post', async (req, res) => {
  try {
    const { pageId, postId, metrics } = req.query || {};
    if (!pageId || !postId) return res.status(400).json({ error: 'Missing pageId or postId' });
    const page = await PageToken.findOne({ pageId });
    if (!page) return res.status(404).json({ error: 'Page not saved' });

    const defaultMetrics = [
      'post_impressions',
      'post_impressions_unique',
      'post_engaged_users',
      'post_clicks',
      'post_reactions_by_type_total',
      'post_video_views',
    ].join(',');

    const resp = await axios.get(`https://graph.facebook.com/v20.0/${postId}/insights`, {
      params: { metric: metrics || defaultMetrics, access_token: page.accessToken },
    });
    res.json(resp.data);
  } catch (e) {
    res.status(400).json({ error: e.response?.data || e.message });
  }
});

// Start server
const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`API on :${port}`));



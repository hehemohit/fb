const mongoose = require('mongoose');

const PageTokenSchema = new mongoose.Schema({
  pageId: { type: String, index: true, unique: true },
  pageName: String,
  accessToken: String, // long-lived PAGE token
  ownerUserId: String, // FB user id who authorized
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('PageToken', PageTokenSchema);



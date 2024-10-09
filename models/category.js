const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  description: { type: String },
  // Add any other fields you need for your category
});

module.exports = mongoose.model('Category', categorySchema);
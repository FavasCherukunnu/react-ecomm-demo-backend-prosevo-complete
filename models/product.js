const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  title: { type: String, required: true },
  description: { type: String, required: true },
  image: { type: String, required: true },
  thumbnail_image: { type: String, required: true },
  price: { type: Number, required: true },
  quantity: { type: Number, required: true },
  category_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true }
});

module.exports = mongoose.model('Product', productSchema);

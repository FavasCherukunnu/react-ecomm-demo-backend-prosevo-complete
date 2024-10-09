const express = require('express');
const path = require('path');
const cors = require('cors');
require('dotenv').config();
const mongoose = require('mongoose');
const sharp = require('sharp');
const cloudinary = require('cloudinary').v2;
const jwt = require('jsonwebtoken');
const User = require('./models/user');
const { storage } = require('./storage/storage');
const multer = require('multer');
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB limit
    fileFilter: (req, file, cb) => {
        // You can add file type checking here if needed
        cb(null, true);
    }
}).single('image');

const handleUpload = (req, res, next) => {
    upload(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            // A Multer error occurred when uploading.
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({
                    success: false,
                    message: 'Image size is too large',
                    error: {
                        image: 'File too large'
                    }
                });
            }
            // Handle other Multer errors here if needed
        } else if (err) {
            // An unknown error occurred when uploading.
            return res.status(500).json({
                success: false,
                message: 'Error uploading file',
                error: {
                    image: 'Upload failed'
                }
            });
        }

        // Everything went fine.
        next();
    });
};

const Product = require('./models/product');
const { body, validationResult, param } = require('express-validator');
const Category = require('./models/category');
const authMiddleware = require('./middleware/admin.authentication');

const app = express();
const port = process.env.PORT;

app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

app.get('/api/me', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }
        res.json({
            success: true,
            message: 'User found',
            user: {
                id: user._id,
                email: user.email
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: 'Error fetching user',
            error: error.message
        });
    }
});

const validateProduct = [
    body('name').notEmpty().withMessage('Product name is required'),
    body('title').notEmpty().withMessage('Product title is required'),
    body('description').notEmpty().withMessage('Product description is required'),
    body('category_id').notEmpty().withMessage('Category ID is required')
        .isMongoId().withMessage('Invalid category ID')
        .custom(async (value) => {
            const category = await Category.findById(value);
            if (!category) {
                throw new Error('Category not found');
            }
            return true;
        }),
    body('price').notEmpty().withMessage('Price is required')
        .isNumeric().withMessage('Price must be a number')
        .isLength({ max: 5 }).withMessage('Price must be less than 100000'),
    body('quantity').notEmpty().withMessage('Quantity is required')
        .isNumeric().withMessage('Quantity must be a number')
        .isLength({ max: 5 }).withMessage('Quantity must be less than 100000'),
];

app.post('/api/product/add',
    authMiddleware,
    handleUpload,
    validateProduct,
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                const errorsResponse = errors.array().reduce((acc, error) => {
                    if (!acc[error.path]) {
                        acc[error.path] = error.msg;
                    }
                    return acc;
                }, {});
                return res.status(400).json({
                    success: false,
                    errors: errorsResponse,
                    message: 'Validation failed'
                });
            }

            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: 'No image file uploaded',
                    errors: { image: 'No image file uploaded' }
                });
            }

            const allowedMimeTypes = ['image/jpeg', 'image/png'];
            if (!allowedMimeTypes.includes(req.file.mimetype)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid image format. Only JPEG and PNG are allowed.',
                    errors: { image: 'Invalid image format' }
                });
            }

            // Compress the original image
            const compressedImageBuffer = await sharp(req.file.buffer)
                .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toBuffer();

            // Create a compressed thumbnail
            const thumbnailBuffer = await sharp(req.file.buffer)
                .resize(200, 200, { fit: 'cover' })
                .jpeg({ quality: 70 })
                .toBuffer();

            // Upload the compressed image to Cloudinary
            const [imageResult, thumbnailResult] = await Promise.all([
                new Promise((resolve, reject) => {
                    const uploadStream = cloudinary.uploader.upload_stream(
                        { folder: 'CloudinaryDemo', format: 'jpg' },
                        (error, result) => {
                            if (error) reject(error);
                            else resolve(result);
                        }
                    );
                    uploadStream.end(compressedImageBuffer);
                }),
                new Promise((resolve, reject) => {
                    const uploadStream = cloudinary.uploader.upload_stream(
                        { folder: 'CloudinaryDemo', format: 'jpg' },
                        (error, result) => {
                            if (error) reject(error);
                            else resolve(result);
                        }
                    );
                    uploadStream.end(thumbnailBuffer);
                })
            ]);

            const newProduct = new Product({
                name: req.body.name,
                title: req.body.title,
                description: req.body.description,
                image: imageResult.secure_url,
                thumbnail_image: thumbnailResult.secure_url,
                category_id: req.body.category_id,
                price: req.body.price,
                quantity: req.body.quantity
            });

            await newProduct.save();
            res.status(201).json({
                success: true,
                message: 'Product added successfully',
                product: newProduct
            });
        } catch (error) {
            console.error(error);
            res.status(500).json({
                success: false,
                message: 'Error processing upload',
            });
        }
    }
);

app.get('/api/products', async (req, res) => {
    try {
        // Pagination
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.perPage) || 10;

        // Sorting
        const sortField = req.query.sortField || 'createdAt';
        const sortOrder = req.query.sortOrder === 'desc' ? -1 : 1;

        // Filtering
        const filterName = req.query.name;
        const filterCategory = req.query.category;

        let query = {};

        if (filterName) {
            query.name = { $regex: filterName, $options: 'i' };
        }

        if (filterCategory) {
            query.category_id = filterCategory;
        }

        // Count total products (for pagination info)
        const totalProducts = await Product.countDocuments(query);

        // Fetch products
        const products = await Product.find(query)
            .select('name title description image thumbnail_image category_id') // Adjust fields as needed
            .sort({ [sortField]: sortOrder })
            .skip((page - 1) * limit)
            .limit(limit)
            .populate('category_id', 'name'); // This will populate the category name

        res.json({
            success: true,
            message: 'Products fetched successfully',
            currentPage: page,
            totalPages: Math.ceil(totalProducts / limit),
            totalProducts: totalProducts,
            productsPerPage: limit,
            products: products
        });
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching products',
            error: error.message
        });
    }
});

// Validation middleware for update
const validateProductUpdate = [
    body('name').optional(),
    body('title').optional(),
    body('description').optional(),
    body('category_id').optional()
        .isMongoId().withMessage('Invalid category ID')
        .custom(async (value) => {
            if (!value) return true;
            const category = await Category.findById(value);
            if (!category) {
                throw new Error('Category not found');
            }
            return true;
        }),
    body('price').optional()
        .isNumeric().withMessage('Price must be a number')
        .isLength({ max: 5 }).withMessage('Price must be less than 100000'),
    body('quantity').optional()
        .isNumeric().withMessage('Quantity must be a number')
        .isLength({ max: 5 }).withMessage('Quantity must be less than 100000'),
]

// Update product route
app.put('/api/product/:id',
    authMiddleware,
    handleUpload,
    validateProductUpdate,
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                const errorsResponse = errors.array().reduce((acc, error) => {
                    if (!acc[error.param]) {
                        acc[error.param] = error.msg;
                    }
                    return acc;
                }, {});
                return res.status(400).json({
                    success: false,
                    errors: errorsResponse,
                    message: 'Validation failed'
                });
            }

            const product = await Product.findById(req.params.id);
            if (!product) {
                return res.status(404).json({
                    success: false,
                    message: 'Product not found'
                });
            }

            // Update text fields
            if (req.body.name) product.name = req.body.name;
            if (req.body.title) product.title = req.body.title;
            if (req.body.description) product.description = req.body.description;
            if (req.body.category_id) product.category_id = req.body.category_id;
            if (req.body.price) product.price = req.body.price;
            if (req.body.quantity) product.quantity = req.body.quantity;

            // Handle image update if a new image is uploaded
            if (req.file) {
                const allowedMimeTypes = ['image/jpeg', 'image/png'];
                if (!allowedMimeTypes.includes(req.file.mimetype)) {
                    return res.status(400).json({
                        success: false,
                        message: 'Invalid image format. Only JPEG and PNG are allowed.',
                        errors: { image: 'Invalid image format' }
                    });
                }

                // Compress the new image
                const compressedImageBuffer = await sharp(req.file.buffer)
                    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 80 })
                    .toBuffer();

                // Create a new thumbnail
                const thumbnailBuffer = await sharp(req.file.buffer)
                    .resize(200, 200, { fit: 'cover' })
                    .jpeg({ quality: 70 })
                    .toBuffer();

                // Upload new images to Cloudinary
                const [imageResult, thumbnailResult] = await Promise.all([
                    new Promise((resolve, reject) => {
                        const uploadStream = cloudinary.uploader.upload_stream(
                            { folder: 'CloudinaryDemo', format: 'jpg' },
                            (error, result) => {
                                if (error) reject(error);
                                else resolve(result);
                            }
                        );
                        uploadStream.end(compressedImageBuffer);
                    }),
                    new Promise((resolve, reject) => {
                        const uploadStream = cloudinary.uploader.upload_stream(
                            { folder: 'CloudinaryDemo', format: 'jpg' },
                            (error, result) => {
                                if (error) reject(error);
                                else resolve(result);
                            }
                        );
                        uploadStream.end(thumbnailBuffer);
                    })
                ]);

                // Delete old images from Cloudinary
                if (product.image) {
                    await cloudinary.uploader.destroy(getPublicIdFromUrl(product.image));
                }
                if (product.thumbnail_image) {
                    await cloudinary.uploader.destroy(getPublicIdFromUrl(product.thumbnail_image));
                }

                // Update product with new image URLs
                product.image = imageResult.secure_url;
                product.thumbnail_image = thumbnailResult.secure_url;
            }

            await product.save();
            res.json({
                success: true,
                message: 'Product updated successfully',
                product: product
            });
        } catch (error) {
            console.error(error);
            res.status(500).json({
                success: false,
                message: 'Error updating product',
            });
        }
    }
);

// Delete product route
app.delete('/api/product/:id',
    authMiddleware,
    param('id').isMongoId().withMessage('Invalid product ID'),
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({
                    success: false,
                    errors: errors.array(),
                    message: 'Validation failed'
                });
            }

            const product = await Product.findById(req.params.id);
            if (!product) {
                return res.status(404).json({
                    success: false,
                    message: 'Product not found'
                });
            }

            // Delete images from Cloudinary
            if (product.image) {
                await cloudinary.uploader.destroy(getPublicIdFromUrl(product.image));
            }
            if (product.thumbnail_image) {
                await cloudinary.uploader.destroy(getPublicIdFromUrl(product.thumbnail_image));
            }

            await Product.findByIdAndDelete(req.params.id);
            res.json({
                success: true,
                message: 'Product deleted successfully'
            });
        } catch (error) {
            console.error(error);
            res.status(500).json({
                success: false,
                message: 'Error deleting product',
            });
        }
    }
);
app.get('/api/product/:id',
    param('id').isMongoId().withMessage('Invalid product ID'),
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({
                    success: false,
                    errors: errors.array(),
                    message: 'Validation failed'
                });
            }

            const product = await Product.findById(req.params.id);
            if (!product) {
                return res.status(404).json({
                    success: false,
                    message: 'Product not found'
                });
            }


            res.json({
                success: true,
                message: 'Product fetched successfully',
                product: product
            });
        } catch (error) {
            console.error(error);
            res.status(500).json({
                success: false,
                message: 'Error deleting product',
            });
        }
    }
);

//get all category
app.get('/api/categories', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.perPage) || 10;
        const sortField = req.query.sortField || 'name';
        const sortOrder = req.query.sortOrder === 'desc' ? -1 : 1;
        const filterName = req.query.name;

        const query = filterName ? { name: { $regex: filterName, $options: 'i' } } : {};

        const totalCategories = await Category.countDocuments(query);

        const categories = await Category.find(query)
            .select('name description') // Add any other fields you want to include
            .sort({ [sortField]: sortOrder })
            .skip((page - 1) * limit)
            .limit(limit);

        res.json({
            success: true,
            count: categories.length,
            totalCategories: totalCategories,
            totalPages: Math.ceil(totalCategories / limit),
            currentPage: page,
            categories: categories
        });
    } catch (error) {
        console.error('Error fetching categories:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching categories',
            error: error.message
        });
    }
});

const validateuser = [
    body('email').notEmpty().withMessage('email is required'),
    body('password').notEmpty().withMessage('password is required'),
];
//login
app.post('/api/login', validateuser, async (req, res) => {

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const errorsResponse = errors.array().reduce((acc, error) => {
            if (!acc[error.path]) {
                acc[error.path] = error.msg;
            }
            return acc;
        }, {});
        return res.status(400).json({
            success: false,
            errors: errorsResponse,
            message: 'Validation failed'
        });
    }

    const { email, password } = req.body;

    try {
        const user = await User.findOne({ email });
        if (!user || user.password !== password) {
            return res.status(400).json({ 
                success: false,
                message: 'Invalid email or password',
             });
        }

        const token = jwt.sign({ userId: user._id }, 'your_jwt_secret', { expiresIn: '1h' });
        res.json({ 
            success: true,
            message: 'Login successful',
            token
         });
    } catch (err) {
        res.status(500).json({ 
            success: false,
            message: 'Error logging in',
         });
    }
});

// Helper function to extract public_id from Cloudinary URL
function getPublicIdFromUrl(url) {
    const parts = url.split('/');
    const filePart = parts[parts.length - 2] + '/' + parts[parts.length - 1].split('.')[0];
    console.log(filePart)
    return filePart;
}


app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
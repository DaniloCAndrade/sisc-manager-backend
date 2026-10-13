const mongoose = require('mongoose');
require('dotenv').config();

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('[svc-platform-control] MongoDB conectado com sucesso!');
    } catch (error) {
        console.error('[svc-platform-control] Erro ao conectar ao MongoDB:', error.message);
        process.exit(1);
    }
};

module.exports = connectDB;
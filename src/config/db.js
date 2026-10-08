import mongoose from 'mongoose';

export async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('⚠️ MONGODB_URI is not set in environment.');
    return;
  }

  const options = {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    maxPoolSize: 20,
    minPoolSize: 2,
  };

  try {
    const conn = await mongoose.connect(uri, options);
    console.log(`🍃 MongoDB Connected: ${conn.connection.host} / ${conn.connection.name}`);
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error.message);
  }

  mongoose.connection.on('error', (err) => {
    console.error('❌ MongoDB runtime error:', err);
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('⚠️ MongoDB disconnected.');
  });

  mongoose.connection.on('reconnected', () => {
    console.log('🔄 MongoDB reconnected.');
  });
}


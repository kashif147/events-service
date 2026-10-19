const mongoose = require("mongoose");

exports.mongooseConnection = async () => {
  // No built-in fallback: without MONGO_URI the service must not start, and it must never connect
  // with a default credential.
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI is not set; refusing to start without database configuration");
  }
  try {

    const options = {
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 30000,
    };

    await mongoose.connect(mongoUri, options).then((data) => {
      console.log(
        `SuccessFully Connected to the MongoDB ===> "${data.connection.name}"`
      );
    });
  } catch (e) {
    console.error("Unable to connect to database:", e);
  }
};

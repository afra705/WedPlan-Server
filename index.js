
import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

const app = express();
const port = 5000;

// middleware
app.use(express.json());
app.use(cors());

// mongodb
const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
  await client.connect();
  console.log("You successfully connected to MongoDB!");
  return client;
}

const connectedClient = await connectToMongoDB();

const database = connectedClient.db('car-wash');

// collections
const users = database.collection('users');
const services = database.collection('services');
const bookings = database.collection('bookings');
const payments = database.collection('payments');

// all apis

app.get('/', (req, res) => {
  res.send('Hello World!');
});



// POST: Add new service
app.post('/services', async (req, res) => {
  try {
    const serviceData = req.body;

    const newService = {
      serviceName: serviceData.serviceName,
      category: serviceData.category,
      description: serviceData.description,
      price: Number(serviceData.price),
      location: serviceData.location,

      status: "pending",
      createdAt: new Date(),
    };

    const result = await services.insertOne(newService);

    res.status(201).send({
      success: true,
      message: "Service added successfully",
      insertedId: result.insertedId,
    });

  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to add service",
      error: error.message,
    });
  }
});


// GET: Get all services
app.get('/services', async (req, res) => {
  try {
    const result = await services
      .find()
      .sort({ createdAt: -1 })
      .toArray();

    res.send(result);

  } catch (error) {
    res.status(500).send({
      message: "Failed to get services",
      error: error.message,
    });
  }
});


// GET: Get single service by ID
app.get('/services/:id', async (req, res) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid service ID",
      });
    }

    const result = await services.findOne({
      _id: new ObjectId(id),
    });

    if (!result) {
      return res.status(404).send({
        message: "Service not found",
      });
    }

    res.send(result);

  } catch (error) {
    res.status(500).send({
      message: "Failed to get service",
      error: error.message,
    });
  }
});


// PATCH: Update service
// app.patch('/services/:id', async (req, res) => {
//   try {
//     const id = req.params.id;

//     if (!ObjectId.isValid(id)) {
//       return res.status(400).send({
//         message: "Invalid service ID",
//       });
//     }

//     const updatedData = req.body;

//     const result = await services.updateOne(
//       { _id: new ObjectId(id) },
//       {
//         $set: {
//           ...updatedData,
//           updatedAt: new Date(),
//         },
//       }
//     );

//     if (result.matchedCount === 0) {
//       return res.status(404).send({
//         message: "Service not found",
//       });
//     }

//     res.send({
//       success: true,
//       message: "Service updated successfully",
//     });

//   } catch (error) {
//     res.status(500).send({
//       message: "Failed to update service",
//       error: error.message,
//     });
//   }
// });


// DELETE: Delete service
// app.delete('/services/:id', async (req, res) => {
//   try {
//     const id = req.params.id;

//     if (!ObjectId.isValid(id)) {
//       return res.status(400).send({
//         message: "Invalid service ID",
//       });
//     }

//     const result = await services.deleteOne({
//       _id: new ObjectId(id),
//     });

//     if (result.deletedCount === 0) {
//       return res.status(404).send({
//         message: "Service not found",
//       });
//     }

//     res.send({
//       success: true,
//       message: "Service deleted successfully",
//     });

//   } catch (error) {
//     res.status(500).send({
//       message: "Failed to delete service",
//       error: error.message,
//     });
//   }
// });


// server
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

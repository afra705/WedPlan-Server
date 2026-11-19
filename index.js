
import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

const app = express();
const port = 5000;

// middleware
app.use(express.json());
app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
  })
);

// mongodb
const client = new MongoClient(process.env.MONGODB_URL);

export async function connectToMongoDB() {
  await client.connect();
  console.log("You successfully connected to MongoDB!");
  return client;
}

const connectedClient = await connectToMongoDB();

const database = connectedClient.db('wedplan');

// collections
const users = database.collection('user');
const services = database.collection('services');
const bookings = database.collection('bookings');
const payments = database.collection('payments');

// all apis

app.get('/', (req, res) => {
  res.send('Hello World!');
});
// Get Total Vendors and Customers

app.get('/users/stats', async (req, res) => {
  try {
    const totalVendors = await users.countDocuments({
      role: "vendor",
    });

    const totalCustomers = await users.countDocuments({
      role: "customer",
    });

    console.log("Total Vendors:", totalVendors);
    console.log("Total Customers:", totalCustomers);

    res.status(200).send({
      totalVendors,
      totalCustomers,
    });

  } catch (error) {
    console.log("User stats error:", error);

    res.status(500).send({
      message: "Failed to get user statistics",
    });
  }
});


// service
app.post('/services', async (req, res) => {
  try {
    const serviceData = {
      ...req.body,
      status: "pending",
      createdAt: new Date(),
    };

    const result = await services.insertOne(serviceData);

    res.send({
      message: "Service added successfully",
      insertedId: result.insertedId,
    });

  } catch (error) {
    res.status(500).send({
      message: "Failed to add service",
    });
  }
});


// GET: Get all services
// GET: Get all services with search and filters
app.get("/services", async (req, res) => {
  try {
    const { search, category, location } = req.query;

    // Filter object
    const filter = {};

    // Search by service name or vendor name
    if (search) {
      filter.$or = [
        {
          serviceName: {
            $regex: search,
            $options: "i",
          },
        },
        {
          vendorName: {
            $regex: search,
            $options: "i",
          },
        },
      ];
    }

    // Filter by category
if (category && category !== "all") {
  filter.category = {
    $regex: `^${category.trim()}$`,
    $options: "i",
  };
}

    // Filter by location
    if (location && location !== "all") {
      filter.location = {
        $regex: location,
        $options: "i",
      };
    }

    // Get filtered services
    const result = await services
      .find(filter)
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


// PATCH: Update Service
app.patch('/services/:id', async (req, res) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid service ID",
      });
    }

    const { serviceName, category, description, price, location, image } = req.body;

    const result = await services.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          serviceName,
          category,
          description,
          price: Number(price),
          location,
          image,
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        message: "Service not found",
      });
    }

    res.send({
      success: true,
      message: "Service updated successfully",
    });

  } catch (error) {
    console.log(error);
    res.status(500).send({
      message: "Failed to update service",
    });
  }
});


// DELETE: Delete Service
app.delete('/services/:id', async (req, res) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid service ID",
      });
    }

    const result = await services.deleteOne({
      _id: new ObjectId(id),
    });

    if (result.deletedCount === 0) {
      return res.status(404).send({
        message: "Service not found",
      });
    }

    res.send({
      success: true,
      message: "Service deleted successfully",
    });

  } catch (error) {
    console.log(error);
    res.status(500).send({
      message: "Failed to delete service",
    });
  }
});
// 

// Update service status
app.patch("/services/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowedStatuses = ["pending", "approved", "rejected"];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).send({ message: "Invalid service status" });
    }

    const result = await services.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status,
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "Service not found" });
    }

    res.send({
      success: true,
      message: `Service ${status} successfully`,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to update service status" });
  }
});

// bookings


app.post("/bookings", async (req, res) => {
  try {
    const {
      serviceId,
      vendorId,
      customerId,
      eventDate,
      eventLocation,
      message,
    } = req.body;

    // Find service
    const service = await services.findOne({
      _id: new ObjectId(serviceId),
    });

    if (!service) {
      return res.status(404).send({
        message: "Service not found!",
      });
    }

    // Prevent own service booking
    if (service.vendorEmail?.toLowerCase() === customerId.toLowerCase()) {
      return res.status(400).send({
        message: "You cannot book your own service!",
      });
    }

    // Check if service is already booked on this date
    const existingBooking = await bookings.findOne({
      serviceId,
      eventDate,
      status: { $in: ["pending", "accepted"] },
    });

if (existingBooking) {
  return res.status(400).send({
    success: false,
  });
}

    // Create booking
    const bookingData = {
      serviceId,
      vendorId,
      customerId,
      eventDate,
      eventLocation,
      message,
      status: "pending",
      createdAt: new Date(),
    };

    const result = await bookings.insertOne(bookingData);

    res.send({
      success: true,
      message: "Booking request submitted successfully!",
      insertedId: result.insertedId,
    });

  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Failed to create booking!",
    });
  }
});



app.get("/my-bookings/:customerId", async (req, res) => {
  try {
    const customerId = req.params.customerId;

    const result = await bookings
      .find({ customerId })
      .sort({ createdAt: -1 })
      .toArray();

    const bookingsWithService = await Promise.all(
      result.map(async (booking) => {
        const service = await services.findOne({
          _id: new ObjectId(booking.serviceId),
        });

        return {
          ...booking,
          service,
        };
      })
    );

    res.send(bookingsWithService);
  } catch (error) {
    res.status(500).send({
      message: "Failed to fetch bookings",
    });
  }
});

app.patch("/bookings/:id/cancel", async (req, res) => {
  try {
    const id = req.params.id;
    const { customerId } = req.body;

    const result = await bookings.updateOne(
      {
        _id: new ObjectId(id),
        customerId: customerId,
        status: "pending",
      },
      {
        $set: {
          status: "cancelled",
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(400).send({
        message: "Booking cannot be cancelled",
      });
    }

    res.send({
      success: true,
      message: "Booking cancelled successfully",
    });
  } catch (error) {
    res.status(500).send({
      message: "Failed to cancel booking",
    });
  }
});

// vendor apis
// Get booking requests for a vendor
app.get("/vendor-booking-requests/:vendorId", async (req, res) => {
  try {
    const vendorId = req.params.vendorId;

    const bookings = await database
      .collection("bookings")
      .find({ vendorId })
      .sort({ createdAt: -1 })
      .toArray();

    // Get service information for each booking
    const bookingsWithService = await Promise.all(
      bookings.map(async (booking) => {
        const service = await database
          .collection("services")
          .findOne({
            _id: new ObjectId(booking.serviceId),
          });

        return {
          ...booking,
          service: service
            ? {
                serviceName: service.serviceName,
                image: service.image,
                vendorName: service.vendorName,
              }
            : null,
        };
      })
    );

    res.send(bookingsWithService);
  } catch (error) {
    res.status(500).send({
      message: "Failed to get booking requests",
    });
  }
});


// Accept or Reject booking
app.patch("/bookings/:id/status", async (req, res) => {
  try {
    const { vendorId, status } = req.body;
    const bookingId = req.params.id;

    // Only accept or reject
    if (!["accepted", "rejected"].includes(status)) {
      return res.status(400).send({
        message: "Invalid booking status",
      });
    }

    const result = await database
      .collection("bookings")
      .updateOne(
        {
          _id: new ObjectId(bookingId),
          vendorId: vendorId,
          status: "pending",
        },
        {
          $set: { status: status },
        }
      );

    if (result.matchedCount === 0) {
      return res.status(400).send({
        message:
          "Booking not found, already processed, or unauthorized",
      });
    }

    res.send({
      message: `Booking ${status} successfully`,
    });
  } catch (error) {
    res.status(500).send({
      message: "Failed to update booking",
    });
  }
});



// server
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

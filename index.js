
import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import { stripe } from './config/stripe.js';
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
const transactions = database.collection('transactions');
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


// GET: Get all services with backend search and filters

app.get("/services", async (req, res) => {
  try {
    const { search, category, location, status, sort } = req.query;

    const filter = {};

    // Search by service name, vendor name or vendor email
    if (search && typeof search === "string") {
      const searchRegex = {
        $regex: search.trim(),
        $options: "i",
      };

      filter.$or = [
        { serviceName: searchRegex },
        { vendorName: searchRegex },
        { vendorEmail: searchRegex },
      ];
    }

    // Filter by category
    if (category && category !== "all") {
      filter.category = {
        $regex: `^${category.trim()}$`,
        $options: "i",
      };
    }

    // Filter by status
    if (status && status !== "all") {
      filter.status = status;
    }

    // Filter by location
    if (location && location !== "all") {
      filter.location = {
        $regex: location.trim(),
        $options: "i",
      };
    }

    // Sort by price
    const sortOrder =
  sort === "low-to-high" ? 1 :
  sort === "high-to-low" ? -1 : null;

    const result = await services
      .find(filter)
      .sort(
        sortOrder !== null
          ? { price: sortOrder }
          : { createdAt: -1 }
      )
      .toArray();

    res.status(200).send(result);
  } catch (error) {
    console.error("Get services error:", error);

    res.status(500).send({
      message: "Failed to get services",
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

// user block / unblock apis

app.patch("/users/:id/block", async (req, res) => {
  try {
    const id = req.params.id;
    const isBlocked = req.body.isBlocked;

    // Check if isBlocked is a boolean
    if (typeof isBlocked !== "boolean") {
      return res.status(400).send({
        message: "Invalid user status",
      });
    }

    // Find user
    const user = await users.findOne({ id: id });

    if (!user) {
      return res.status(404).send({
        message: "User not found",
      });
    }

    // Admin cannot be blocked
    if (user.role === "admin") {
      return res.status(403).send({
        message: "Admin cannot be blocked",
      });
    }

    // Update user status
    await users.updateOne(
      { id: id },
      {
        $set: {
          isBlocked: isBlocked,
        },
      }
    );

    res.send({
      success: true,
      message: isBlocked
        ? "User blocked successfully"
        : "User unblocked successfully",
    });

  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Failed to update user status",
    });
  }
});

// transactions

app.post("/create-checkout-session", async (req, res) => {
  try {
    // Temporary testing only. JWT authentication will be added later.
    const { vendorId } = req.body;

    // Validate vendor ID
    if (!vendorId) {
      return res.status(400).send({
        success: false,
        message: "Vendor ID is required",
      });
    }

    // Find vendor
 const vendor = await users.findOne({
  _id: new ObjectId(vendorId),
  role: "vendor",
});

    if (!vendor) {
      return res.status(404).send({
        success: false,
        message: "Vendor not found",
      });
    }

    // Prevent duplicate subscription
    if (vendor.subscriptionPlan === "premium") {
      return res.status(400).send({
        success: false,
        message: "You already have a Premium subscription",
      });
    }

    // Get Stripe Price
    const price = await stripe.prices.retrieve(
      process.env.STRIPE_PRICE_ID
    );

    if (!price.active || price.unit_amount === null) {
      return res.status(400).send({
        success: false,
        message: "Invalid or inactive Stripe price",
      });
    }

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",

      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],

      metadata: {
        vendorId,
        plan: "premium",
      },

      subscription_data: {
        metadata: {
          vendorId,
          plan: "premium",
        },
      },

      success_url: `${process.env.CLIENT_URL}/vendor/subscription/success?session_id={CHECKOUT_SESSION_ID}`,

      cancel_url: `${process.env.CLIENT_URL}/vendor/subscription/cancel`,
    });

    // Save pending transaction
    await transactions.insertOne({
      vendorId,
      plan: "premium",
      amount: price.unit_amount / 100,
      currency: price.currency,
      stripeSessionId: session.id,
      stripeSubscriptionId: null,
      status: "pending",
      createdAt: new Date(),
    });

    // Send Checkout URL
    res.send({
      success: true,
      url: session.url,
    });

  } catch (error) {
    console.error("Stripe Checkout Error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to create checkout session",
    });
  }
});





// server
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

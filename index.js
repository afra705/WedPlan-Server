
import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import { stripe } from "./config/stripe.js";

const app = express();
const port = process.env.PORT || 5000;

// ========================================
// 1. CORS MIDDLEWARE
// ========================================

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      process.env.CLIENT_URL,
    ].filter(Boolean),
    credentials: true,
  })
);

// ========================================
// 2. MONGODB CONNECTION
// ========================================

const client = new MongoClient(process.env.MONGODB_URL);

export async function connectToMongoDB() {
  await client.connect();

  console.log("You successfully connected to MongoDB!");

  return client;
}

const connectedClient = await connectToMongoDB();

const database = connectedClient.db("wedplan");

// Collections
const users = database.collection("user");
const services = database.collection("services");
const bookings = database.collection("bookings");
const transactions = database.collection("transactions");
const payments = database.collection("payments");

// ========================================
// 3. STRIPE WEBHOOK
// IMPORTANT: Must be BEFORE express.json()
// ========================================

app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];

    let event;

    // Verify Stripe webhook signature
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.error("Webhook signature error:", error.message);

      return res.status(400).send(
        `Webhook Error: ${error.message}`
      );
    }

    // Checkout completed successfully
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      try {
        const result = await transactions.updateOne(
          {
            stripeSessionId: session.id,
          },
          {
            $set: {
              status: "paid",
              stripeSubscriptionId: session.subscription ?? null,
            },
          }
        );

        console.log("Payment successful:", session.id);
        console.log("Updated transactions:", result.modifiedCount);
      } catch (error) {
        console.error("Transaction update error:", error);

        return res.status(500).send(
          "Failed to update transaction"
        );
      }
    }

    res.status(200).send({
      received: true,
    });
  }
);

// ========================================
// 4. NORMAL JSON MIDDLEWARE
// All normal API routes come after this
// ========================================

app.use(express.json());

// ========================================
// 5. HOME API
// ========================================

app.get("/", (req, res) => {
  res.send("Hello World!");
});

// ========================================
// 6. USER STATISTICS
// ========================================

app.get("/users/stats", async (req, res) => {
  try {
    const totalVendors = await users.countDocuments({
      role: "vendor",
    });

    const totalCustomers = await users.countDocuments({
      role: "customer",
    });

    res.status(200).send({
      totalVendors,
      totalCustomers,
    });
  } catch (error) {
    console.error("User stats error:", error);

    res.status(500).send({
      message: "Failed to get user statistics",
    });
  }
});

// ========================================
// 7. SERVICES APIs
// ========================================

// POST: Add a service

app.post("/services", async (req, res) => {
  try {
    const serviceData = {
      ...req.body,
      status: "pending",
      createdAt: new Date(),
    };

    const result = await services.insertOne(serviceData);

    res.status(201).send({
      success: true,
      message: "Service added successfully",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("Add service error:", error);

    res.status(500).send({
      message: "Failed to add service",
    });
  }
});

// GET: Get all services with search and filters

app.get("/services", async (req, res) => {
  try {
    const {
      search,
      category,
      location,
      status,
      sort,
    } = req.query;

    const filter = {};

    // Search by service name, vendor name or email
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

    // Category filter
    if (category && category !== "all") {
      filter.category = {
        $regex: `^${category.trim()}$`,
        $options: "i",
      };
    }

    // Status filter
    if (status && status !== "all") {
      filter.status = status;
    }

    // Location filter
    if (location && location !== "all") {
      filter.location = {
        $regex: location.trim(),
        $options: "i",
      };
    }

    // Price sorting
    const sortOrder =
      sort === "low-to-high"
        ? 1
        : sort === "high-to-low"
          ? -1
          : null;

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

app.get("/services/:id", async (req, res) => {
  try {
    const { id } = req.params;

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

    res.status(200).send(result);
  } catch (error) {
    console.error("Get single service error:", error);

    res.status(500).send({
      message: "Failed to get service",
    });
  }
});

// PATCH: Update service

app.patch("/services/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid service ID",
      });
    }

    const {
      serviceName,
      category,
      description,
      price,
      location,
      image,
    } = req.body;

    const result = await services.updateOne(
      {
        _id: new ObjectId(id),
      },
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
    console.error("Update service error:", error);

    res.status(500).send({
      message: "Failed to update service",
    });
  }
});

// DELETE: Delete service

app.delete("/services/:id", async (req, res) => {
  try {
    const { id } = req.params;

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
    console.error("Delete service error:", error);

    res.status(500).send({
      message: "Failed to delete service",
    });
  }
});

// PATCH: Update service status

app.patch("/services/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid service ID",
      });
    }

    const allowedStatuses = [
      "pending",
      "approved",
      "rejected",
    ];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).send({
        message: "Invalid service status",
      });
    }

    const result = await services.updateOne(
      {
        _id: new ObjectId(id),
      },
      {
        $set: {
          status,
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
      message: `Service ${status} successfully`,
    });
  } catch (error) {
    console.error("Update service status error:", error);

    res.status(500).send({
      message: "Failed to update service status",
    });
  }
});

// ========================================
// 8. CUSTOMER BOOKING APIs
// ========================================

// GET: Get all bookings

app.get("/bookings", async (req, res) => {
  try {
    const result = await bookings
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).send(result);
  } catch (error) {
    console.error("Get all bookings error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch all bookings",
    });
  }
});

// POST: Create booking

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

    if (!serviceId || !vendorId || !customerId) {
      return res.status(400).send({
        success: false,
        message: "Required booking information is missing",
      });
    }

    if (!ObjectId.isValid(serviceId)) {
      return res.status(400).send({
        message: "Invalid service ID",
      });
    }

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
    if (
      service.vendorEmail?.toLowerCase() ===
      customerId.toLowerCase()
    ) {
      return res.status(400).send({
        message: "You cannot book your own service!",
      });
    }

    // Check existing booking on same date
    const existingBooking = await bookings.findOne({
      serviceId,
      eventDate,
      status: {
        $in: ["pending", "accepted"],
      },
    });

    if (existingBooking) {
      return res.status(400).send({
        success: false,
        message: "This service is already booked on this date",
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

    res.status(201).send({
      success: true,
      message: "Booking request submitted successfully!",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("Create booking error:", error);

    res.status(500).send({
      message: "Failed to create booking!",
    });
  }
});

// GET: Get bookings for a customer

app.get("/my-bookings/:customerId", async (req, res) => {
  try {
    const { customerId } = req.params;

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
    console.error("My bookings error:", error);

    res.status(500).send({
      message: "Failed to fetch bookings",
    });
  }
});

// PATCH: Cancel booking

app.patch("/bookings/:id/cancel", async (req, res) => {
  try {
    const { id } = req.params;
    const { customerId } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid booking ID",
      });
    }

    const result = await bookings.updateOne(
      {
        _id: new ObjectId(id),
        customerId,
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
    console.error("Cancel booking error:", error);

    res.status(500).send({
      message: "Failed to cancel booking",
    });
  }
});

// ========================================
// 9. VENDOR BOOKING APIs
// ========================================

// GET: Get booking requests for a vendor

app.get(
  "/vendor-booking-requests/:vendorId",
  async (req, res) => {
    try {
      const { vendorId } = req.params;

      const vendorBookings = await bookings
        .find({ vendorId })
        .sort({ createdAt: -1 })
        .toArray();

      const bookingsWithService = await Promise.all(
        vendorBookings.map(async (booking) => {
          const service = await services.findOne({
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
      console.error("Vendor booking requests error:", error);

      res.status(500).send({
        message: "Failed to get booking requests",
      });
    }
  }
);

// PATCH: Accept or reject booking

app.patch("/bookings/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { vendorId, status } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid booking ID",
      });
    }

    if (!["accepted", "rejected"].includes(status)) {
      return res.status(400).send({
        message: "Invalid booking status",
      });
    }

    const result = await bookings.updateOne(
      {
        _id: new ObjectId(id),
        vendorId,
        status: "pending",
      },
      {
        $set: {
          status,
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(400).send({
        message: "Booking not found, already processed, or unauthorized",
      });
    }

    res.send({
      success: true,
      message: `Booking ${status} successfully`,
    });
  } catch (error) {
    console.error("Update booking status error:", error);

    res.status(500).send({
      message: "Failed to update booking",
    });
  }
});

// ========================================
// 10. USER BLOCK / UNBLOCK API
// ========================================

app.patch("/users/:id/block", async (req, res) => {
  try {
    const { id } = req.params;
    const { isBlocked } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid user ID",
      });
    }

    if (typeof isBlocked !== "boolean") {
      return res.status(400).send({
        message: "Invalid user status",
      });
    }

    // Find user by MongoDB _id
    const user = await users.findOne({
      _id: new ObjectId(id),
    });

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

    await users.updateOne(
      {
        _id: new ObjectId(id),
      },
      {
        $set: {
          isBlocked,
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
    console.error("Block user error:", error);

    res.status(500).send({
      message: "Failed to update user status",
    });
  }
});

// ========================================
// 11. STRIPE TRANSACTION APIs
// ========================================

// GET: Get all transactions with vendor information

app.get("/transactions", async (req, res) => {
  try {
    const allTransactions = await transactions
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    const transactionsWithVendor = await Promise.all(
      allTransactions.map(async (transaction) => {
        let vendor = null;

        if (ObjectId.isValid(transaction.vendorId)) {
          vendor = await users.findOne({
            _id: new ObjectId(transaction.vendorId),
          });
        }

        return {
          ...transaction,
          vendor: vendor
            ? {
                name: vendor.name,
                email: vendor.email,
                businessName: vendor.businessName,
                image: vendor.image,
              }
            : null,
        };
      })
    );

    res.status(200).send({
      success: true,
      transactions: transactionsWithVendor,
    });
  } catch (error) {
    console.error("Get transactions error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch transactions",
    });
  }
});

// POST: Create Stripe Checkout Session

app.post("/create-checkout-session", async (req, res) => {
  try {
    // Temporary testing only.
    // In production, get vendorId from verified authentication.

    const { vendorId } = req.body;

    if (!vendorId) {
      return res.status(400).send({
        success: false,
        message: "Vendor ID is required",
      });
    }

    if (!ObjectId.isValid(vendorId)) {
      return res.status(400).send({
        success: false,
        message: "Invalid vendor ID",
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

    // Retrieve Stripe Price
    const price = await stripe.prices.retrieve(
      process.env.STRIPE_PRICE_ID
    );

    if (!price.active || price.unit_amount === null) {
      return res.status(400).send({
        success: false,
        message: "Invalid or inactive Stripe price",
      });
    }

    // Create Checkout Session
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

    // Send Checkout URL to frontend
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

// ========================================
// 12. SERVER
// ========================================

app.listen(port, () => {
  console.log(`WedPlan server listening on port ${port}`);
});

export default app;


import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import { stripe } from "./config/stripe.js";
import { createRemoteJWKSet, jwtVerify } from "jose";

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

await client.connect();

console.log("MongoDB Connected Successfully!");

const database = client.db("wedplan");

const users = database.collection("user");
const services = database.collection("services");
const bookings = database.collection("bookings");
const transactions = database.collection("transactions");


// 3. JWT CONFIGURATION


const authBaseUrl =
  process.env.CLIENT_URL || process.env.BETTER_AUTH_URL;

if (!authBaseUrl) {
  throw new Error(
    "CLIENT_URL is required so the backend can read /api/auth/jwks"
  );
}
console.log("Auth Base URL:", authBaseUrl);
const JWKS = createRemoteJWKSet(
  new URL(`${authBaseUrl}/api/auth/jwks`)
);

// ========================================
// 4. VERIFY TOKEN MIDDLEWARE
// ========================================


const verifyToken = async (req, res, next) => {
  try {
    // 1. Get Authorization Header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).send({
        success: false,
        message: "Unauthorized",
      });
    }

    // 2. Get Bearer Token
    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      return res.status(401).send({
        success: false,
        message: "Invalid authorization format",
      });
    }

    // 3. Verify JWT Signature and Expiration
    const { payload } = await jwtVerify(token, JWKS);

    // 4. Get User ID from JWT
    const userId = payload.sub;

    if (!userId) {
      return res.status(401).send({
        success: false,
        message: "Invalid token",
      });
    }

    // 5. Find User in MongoDB
    let user = null;

    if (ObjectId.isValid(userId)) {
      user = await users.findOne({
        _id: new ObjectId(userId),
      });
    }

    // Fallback for string ID
    if (!user) {
      user = await users.findOne({
        id: userId,
      });
    }

    if (!user) {
      return res.status(401).send({
        success: false,
        message: "User not found",
      });
    }

    // 6. Check Better Auth Ban Status
// Check Better Auth ban status
const activeBan =
  user.banned === true &&
  (
    !user.banExpires ||
    new Date(user.banExpires).getTime() > Date.now()
  );

// Check both custom and Better Auth block status
if (user.isBlocked === true || activeBan) {
  return res.status(403).send({
    success: false,
    message: "Your account has been blocked. Please contact support.",
  });
}

    // 7. Store Authenticated User
    req.user = user;

    next();

  } catch (error) {
    console.error("JWT ERROR:", error.code || error.name);
    console.error("JWT MESSAGE:", error.message);

    return res.status(401).send({
      success: false,
      message: "Invalid or expired token",
    });
  }
};


// ========================================
// 5. ROLE VERIFICATION MIDDLEWARE
// Must use after verifyToken
// ========================================

// `role` is only for admin. Vendor/customer is stored in `accountType`.
// Older users stored vendor/customer in `role`, so keep that as a fallback.
const getAccountType = (user) => {
  if (user.accountType === "vendor" || user.accountType === "customer") {
    return user.accountType;
  }

  if (user.role === "vendor" || user.role === "customer") {
    return user.role;
  }

  return "customer";
};

// Mirrors the frontend rule: premium counts only while the paid period is
// still in the future. The Stripe webhook owns both fields.
const isPremiumActive = (user) =>
  user?.subscriptionPlan === "premium" &&
  !!user.subscriptionExpiresAt &&
  new Date(user.subscriptionExpiresAt).getTime() > Date.now();

// Verify Vendor

const verifyVendor = (req, res, next) => {
  if (
    req.user.role === "admin" ||
    getAccountType(req.user) !== "vendor"
  ) {
    return res.status(403).send({
      message: "Forbidden: Vendor access only",
    });
  }

  next();
};

// Verify Customer

const verifyCustomer = (req, res, next) => {
  if (
    req.user.role === "admin" ||
    getAccountType(req.user) !== "customer"
  ) {
    return res.status(403).send({
      message: "Forbidden: Customer access only",
    });
  }

  next();
};

// Verify Admin

const verifyAdmin = (req, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).send({
      message: "Forbidden: Admin access only",
    });
  }

  next();
};

// ========================================
// 6. HELPER FUNCTION
// ========================================

const getUserId = (user) => {
  return String(user._id ?? user.id);
};

const findUserById = async (userId) => {
  if (!userId) return null;

  let user = null;

  if (ObjectId.isValid(String(userId))) {
    user = await users.findOne({
      _id: new ObjectId(String(userId)),
    });
  }

  if (!user) {
    user = await users.findOne({
      id: String(userId),
    });
  }

  return user;
};

// Count vendors/customers, with a fallback for older user documents.
const countUsersByAccountType = (accountType) => {
  return users.countDocuments({
    $or: [
      { accountType },
      { role: accountType },
    ],
  });
};

// ========================================
// 7. STRIPE WEBHOOK
// Must be before express.json()
// JWT is not required here
// ========================================

// Stripe moved `current_period_end` onto subscription items. Use the latest
// item period so the plan stays active for the full paid period.
const getSubscriptionPeriodEnd = (subscription) => {
  const itemPeriods = (subscription?.items?.data ?? [])
    .map((item) => item.current_period_end)
    .filter((value) => Number.isFinite(value));

  if (itemPeriods.length > 0) {
    return new Date(Math.max(...itemPeriods) * 1000);
  }

  // Fallback if Stripe does not return item periods.
  const fallback = new Date();
  fallback.setDate(fallback.getDate() + 30);
  return fallback;
};

const webhookLog = (message, details = {}) => {
  console.log(
    `[stripe-webhook] ${message}`,
    JSON.stringify(details)
  );
};

const retrieveSubscription = async (subscriptionId) => {
  if (!subscriptionId) return null;

  try {
    return await stripe.subscriptions.retrieve(subscriptionId);
  } catch (error) {
    console.error(
      "[stripe-webhook] Failed to retrieve subscription:",
      subscriptionId,
      error.message
    );

    return null;
  }
};


const setSubscriptionState = async (
  vendorId,
  subscriptionPlan,
  subscriptionExpiresAt,
  context = {}
) => {
  const vendor = await findUserById(vendorId);

  if (!vendor) {
    throw new Error(`Vendor not found: ${vendorId}`);
  }

  const requestedExpiry =
    subscriptionExpiresAt instanceof Date
      ? subscriptionExpiresAt
      : new Date(subscriptionExpiresAt);

  let effectiveExpiry = requestedExpiry;

  if (subscriptionPlan === "premium") {
    const currentExpiry = vendor.subscriptionExpiresAt
      ? new Date(vendor.subscriptionExpiresAt).getTime()
      : 0;

    if (
      Number.isFinite(currentExpiry) &&
      currentExpiry > effectiveExpiry.getTime()
    ) {
      effectiveExpiry = new Date(currentExpiry);
    }
  }

  const result = await users.updateOne(
    { _id: vendor._id },
    {
      $set: {
        subscriptionPlan,
        subscriptionExpiresAt: effectiveExpiry,
        updatedAt: new Date(),
      },
    }
  );

  if (result.matchedCount === 0) {
    throw new Error(`MongoDB user update failed: ${vendorId}`);
  }

  console.log("Subscription Updated:", {
    ...context,
    vendorId,
    email: vendor.email,
    plan: subscriptionPlan,
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
    expiresAt: effectiveExpiry,
  });

  return result;
};

const activatePremium = async ({
  vendorId,
  subscription,
  context,
}) =>
  setSubscriptionState(
    vendorId,
    "premium",
    getSubscriptionPeriodEnd(subscription),
    context
  );

app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.error(
        "[stripe-webhook] Signature verification failed:",
        error.message
      );

      return res.status(400).send(
        `Webhook Error: ${error.message}`
      );
    }

    webhookLog("Event verified", {
      eventId: event.id,
      type: event.type,
      livemode: event.livemode,
    });

    try {
      
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;


        
        webhookLog("Checkout session", {
          eventId: event.id,
          sessionId: session.id,
          paymentStatus: session.payment_status,
          status: session.status,
          mode: session.mode,
          vendorId: session.metadata?.vendorId ?? null,
          clientReferenceId: session.client_reference_id ?? null,
          subscription: session.subscription ?? null,
        });

        // Only activate premium after successful payment
        if (
  !["paid", "no_payment_required"].includes(
    session.payment_status
  )
) {
  webhookLog("Skipped: payment not completed", {
    eventId: event.id,
    paymentStatus: session.payment_status,
  });

  return res.status(200).send({
    received: true,
  });
}

        const transaction = await transactions.findOne({
          stripeSessionId: session.id,
        });

        // Prefer the metadata set when the checkout session was created.
        // This also covers the race where the webhook arrives before the
        // pending transaction is written.
        const vendorId =
          session.metadata?.vendorId ||
          session.client_reference_id ||
          transaction?.vendorId;

     if (!vendorId) {
  throw new Error(
    `Vendor ID missing for Stripe session: ${session.id}`
  );
}

        // Update Transaction
        if (transaction) {
          await transactions.updateOne(
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

          webhookLog("Transaction marked paid", {
            eventId: event.id,
            sessionId: session.id,
          });
        } else {
          console.warn(
            "[stripe-webhook] Pending transaction not found (race?); continuing with metadata vendorId:",
            session.id
          );
        }

        // Read the paid period from Stripe so `subscriptionExpiresAt` is a
        // real future date (the frontend requires it for Premium). If the
        // lookup fails we still activate with the fallback period.
        const subscription = await retrieveSubscription(
          session.subscription
        );

        await activatePremium({
          vendorId,
          subscription,
          context: {
            eventId: event.id,
            sessionId: session.id,
          },
        });

        webhookLog("Checkout activation complete", {
          eventId: event.id,
          sessionId: session.id,
          vendorId,
        });
      }

      // Subscription renewals also arrive as paid invoices. Handling this
      // keeps the expiry fresh even if checkout.session.completed is missed.
      if (
        event.type === "invoice.paid" ||
        event.type === "invoice.payment_succeeded"
      ) {
        const invoice = event.data.object;
        const subscriptionDetails =
          invoice.parent?.subscription_details;
        const subscriptionId =
          subscriptionDetails?.subscription || invoice.subscription;

        const subscription =
          await retrieveSubscription(subscriptionId);

        const vendorId =
          subscription?.metadata?.vendorId ||
          subscriptionDetails?.metadata?.vendorId;

        webhookLog("Paid invoice", {
          eventId: event.id,
          invoiceId: invoice.id,
          billingReason: invoice.billing_reason,
          subscriptionId: subscriptionId ?? null,
          vendorId: vendorId ?? null,
        });

        if (vendorId) {
          await activatePremium({
            vendorId,
            subscription,
            context: {
              eventId: event.id,
              invoiceId: invoice.id,
              source: "invoice",
            },
          });
        }
      }

      // Keep the expiry accurate on renewals and downgrade when Stripe ends
      // the subscription. Both events carry the vendorId metadata.
      if (
        event.type === "customer.subscription.updated" ||
        event.type === "customer.subscription.deleted"
      ) {
        const subscription = event.data.object;
        const vendorId = subscription.metadata?.vendorId;

        webhookLog("Subscription lifecycle", {
          eventId: event.id,
          subscriptionId: subscription.id,
          status: subscription.status,
          vendorId: vendorId ?? null,
        });

        if (vendorId) {
          const isActive =
            event.type === "customer.subscription.updated" &&
            ["active", "trialing", "past_due"].includes(
              subscription.status
            );

          await setSubscriptionState(
            vendorId,
            isActive ? "premium" : "free",
            getSubscriptionPeriodEnd(subscription),
            {
              eventId: event.id,
              subscriptionId: subscription.id,
              source: "subscription",
            }
          );
        }
      }

      res.status(200).send({
        received: true,
      });

    } catch (error) {
      console.error(
        "[stripe-webhook] Processing failed:",
        event?.id,
        error
      );

      res.status(500).send({
        message: "Webhook processing failed",
      });
    }
  }
);

// ========================================
// 8. NORMAL JSON MIDDLEWARE
// ========================================

app.use(express.json());

// ========================================
// 9. HOME API
// Public API
// ========================================

app.get("/", (req, res) => {
  res.send("WedPlan Server is Running!");
});

// ========================================
// 10. USER STATISTICS
// Admin Only
// ========================================

app.get(
  "/users/stats",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const totalVendors = await countUsersByAccountType("vendor");
      const totalCustomers = await countUsersByAccountType("customer");

      res.status(200).send({
        totalVendors,
        totalCustomers,
      });

    } catch (error) {
      console.error("User Stats Error:", error);

      res.status(500).send({
        message: "Failed to get user statistics",
      });
    }
  }
);

// ========================================
// 11. SERVICES APIs
// ========================================

// POST: Add Service
// Vendor Only


app.post(
  "/services",
  verifyToken,
  verifyVendor,
  async (req, res) => {
    try {
      const {
        serviceName,
        category,
        description,
        price,
        location,
        image,
        images,
      } = req.body;

      // Validate required fields
      if (
        !serviceName?.trim() ||
        !category ||
        !description?.trim() ||
        !location?.trim() ||
        price === undefined
      ) {
        return res.status(400).send({
          success: false,
          message: "All required fields must be provided",
        });
      }

      // Validate price
      if (
        !Number.isFinite(Number(price)) ||
        Number(price) <= 0
      ) {
        return res.status(400).send({
          success: false,
          message: "Invalid service price",
        });
      }

      // Check Free Plan Limit
      const totalServices = await services.countDocuments({
        vendorId: getUserId(req.user),
      });

      if (
        !isPremiumActive(req.user) &&
        totalServices >= 3
      ) {
        return res.status(403).send({
          success: false,
          message:
            "Free plan allows only 3 services. Upgrade to Premium!",
        });
      }

      // Prepare Service Data
      const serviceData = {
        vendorId: getUserId(req.user),
        vendorName: req.user.name,
        vendorEmail: req.user.email,

        serviceName: serviceName.trim(),
        category,
        description: description.trim(),
        price: Number(price),
        location: location.trim(),

        image: image || "",
        images: Array.isArray(images)
          ? images
          : image
            ? [image]
            : [],

        status: "pending",
        isActive: true,

        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Save Service
      const result = await services.insertOne(serviceData);

      res.status(201).send({
        success: true,
        message: "Service added successfully",
        insertedId: result.insertedId,
      });

    } catch (error) {
      console.error("Add Service Error:", error);

      res.status(500).send({
        success: false,
        message: "Failed to add service",
      });
    }
  }
);


// GET: All Approved Services
// Public API

app.get("/services", async (req, res) => {
  try {
    const {
      search,
      category,
      location,
      sort,
    } = req.query;

    const filter = {
      status: "approved",
      isActive: { $ne: false },
    };

    if (search && typeof search === "string") {
      filter.serviceName = {
        $regex: search.trim(),
        $options: "i",
      };
    }

    if (category && category !== "all") {
      filter.category = {
        $regex: `^${category.trim()}$`,
        $options: "i",
      };
    }

    if (location && location !== "all") {
      filter.location = {
        $regex: location.trim(),
        $options: "i",
      };
    }

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
    console.error("Get Services Error:", error);

    res.status(500).send({
      message: "Failed to get services",
    });
  }
});

// GET: Single Service
// Public API

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
      status: "approved",
      isActive: { $ne: false },
    });

    if (!result) {
      return res.status(404).send({
        message: "Service not found",
      });
    }

    res.status(200).send(result);

  } catch (error) {
    console.error("Get Single Service Error:", error);

    res.status(500).send({
      message: "Failed to get service",
    });
  }
});

// GET: My Services
// Vendor Only

app.get(
  "/my-services",
  verifyToken,
  verifyVendor,
  async (req, res) => {
    try {
      const result = await services
        .find({
          vendorId: getUserId(req.user),
        })
        .sort({ createdAt: -1 })
        .toArray();

      res.send(result);

    } catch (error) {
      console.error("My Services Error:", error);

      res.status(500).send({
        message: "Failed to get your services",
      });
    }
  }
);

// PATCH: Update Service
// Vendor Only + Ownership Check

app.patch(
  "/services/:id",
  verifyToken,
  verifyVendor,
  async (req, res) => {
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
        images,
      } = req.body;

      const updateData = {
        updatedAt: new Date(),
      };

      if (serviceName !== undefined) updateData.serviceName = serviceName;
      if (category !== undefined) updateData.category = category;
      if (description !== undefined) updateData.description = description;
      if (location !== undefined) updateData.location = location;
      if (image !== undefined) updateData.image = image;
      if (images !== undefined) updateData.images = images;

      if (price !== undefined) {
        if (!Number.isFinite(Number(price)) || Number(price) < 0) {
          return res.status(400).send({
            message: "Invalid service price",
          });
        }

        updateData.price = Number(price);
      }

      const result = await services.updateOne(
        {
          _id: new ObjectId(id),
          vendorId: getUserId(req.user),
        },
        {
          $set: updateData,
        }
      );

      if (result.matchedCount === 0) {
        return res.status(404).send({
          message: "Service not found or unauthorized",
        });
      }

      res.send({
        success: true,
        message: "Service updated successfully",
      });

    } catch (error) {
      console.error("Update Service Error:", error);

      res.status(500).send({
        message: "Failed to update service",
      });
    }
  }
);

// DELETE: Delete Service
// Vendor Only + Ownership Check

app.delete(
  "/services/:id",
  verifyToken,
  verifyVendor,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          message: "Invalid service ID",
        });
      }

      const result = await services.deleteOne({
        _id: new ObjectId(id),
        vendorId: getUserId(req.user),
      });

      if (result.deletedCount === 0) {
        return res.status(404).send({
          message: "Service not found or unauthorized",
        });
      }

      res.send({
        success: true,
        message: "Service deleted successfully",
      });

    } catch (error) {
      console.error("Delete Service Error:", error);

      res.status(500).send({
        message: "Failed to delete service",
      });
    }
  }
);

// PATCH: Admin Approve / Reject Service
// Admin Only

app.patch(
  "/services/:id/status",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          message: "Invalid service ID",
        });
      }

      if (!["approved", "rejected"].includes(status)) {
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
      console.error("Service Status Error:", error);

      res.status(500).send({
        message: "Failed to update service status",
      });
    }
  }
);


// PATCH - Update Service Availability (Admin)

app.patch(
  "/services/:id/availability",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { isActive } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          success: false,
          message: "Invalid service ID",
        });
      }

      if (typeof isActive !== "boolean") {
        return res.status(400).send({
          success: false,
          message: "Invalid availability status",
        });
      }

      const service = await services.findOne({
        _id: new ObjectId(id),
      });

      if (!service) {
        return res.status(404).send({
          success: false,
          message: "Service not found",
        });
      }

      if (service.status !== "approved") {
        return res.status(400).send({
          success: false,
          message: "Only approved services can change availability",
        });
      }

      await services.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            isActive,
            updatedAt: new Date(),
          },
        }
      );

      res.send({
        success: true,
        message: `Service ${isActive ? "activated" : "deactivated"} successfully`,
        isActive,
      });

    } catch (error) {
      console.error("Service Availability Error:", error);

      res.status(500).send({
        success: false,
        message: "Failed to update service availability",
      });
    }
  }
);



// ========================================
// 12. CUSTOMER BOOKING APIs
// ========================================

// POST: Create Booking
// Customer Only

app.post(
  "/bookings",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      const {
        serviceId,
        eventDate,
        eventLocation,
        message,
      } = req.body;

      if (!serviceId || !eventDate || !eventLocation) {
        return res.status(400).send({
          message: "Required booking information is missing",
        });
      }

      if (!ObjectId.isValid(serviceId)) {
        return res.status(400).send({
          message: "Invalid service ID",
        });
      }

      const service = await services.findOne({
        _id: new ObjectId(serviceId),
        status: "approved",
        isActive: { $ne: false },
      });

      if (!service) {
        return res.status(404).send({
          message: "Service not found or unavailable",
        });
      }

      // Prevent booking own service
      if (
        String(service.vendorId) === getUserId(req.user) ||
        service.vendorEmail?.toLowerCase() === req.user.email?.toLowerCase()
      ) {
        return res.status(403).send({
          message: "You cannot book your own service",
        });
      }

      // Prevent duplicate active booking
      const existingBooking = await bookings.findOne({
        serviceId,
        eventDate,
        status: {
          $in: ["pending", "accepted"],
        },
      });

      if (existingBooking) {
        return res.status(400).send({
          message: "This service is already booked on this date",
        });
      }

      // Never trust customerId or vendorId from frontend
      const bookingData = {
        serviceId,
        vendorId: String(service.vendorId),
        customerId: getUserId(req.user),
        eventDate,
        eventLocation,
        message: message || "",
        status: "pending",
        createdAt: new Date(),
      };

      const result = await bookings.insertOne(bookingData);

      res.status(201).send({
        success: true,
        message: "Booking request submitted successfully",
        insertedId: result.insertedId,
      });

    } catch (error) {
      console.error("Create Booking Error:", error);

      res.status(500).send({
        message: "Failed to create booking",
      });
    }
  }
);

// GET: My Bookings
// Customer Only

app.get(
  "/my-bookings",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      const result = await bookings
        .find({
          customerId: getUserId(req.user),
        })
        .sort({ createdAt: -1 })
        .toArray();

      const bookingsWithService = await Promise.all(
        result.map(async (booking) => {
          const service = ObjectId.isValid(booking.serviceId)
            ? await services.findOne({
                _id: new ObjectId(booking.serviceId),
              })
            : null;

          return {
            ...booking,
            service,
          };
        })
      );

      res.send(bookingsWithService);

    } catch (error) {
      console.error("My Bookings Error:", error);

      res.status(500).send({
        message: "Failed to fetch bookings",
      });
    }
  }
);

// PATCH: Cancel Booking
// Customer Only + Ownership Check

app.patch(
  "/bookings/:id/cancel",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          message: "Invalid booking ID",
        });
      }

      const result = await bookings.updateOne(
        {
          _id: new ObjectId(id),
          customerId: getUserId(req.user),
          status: "pending",
        },
        {
          $set: {
            status: "cancelled",
            updatedAt: new Date(),
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
      console.error("Cancel Booking Error:", error);

      res.status(500).send({
        message: "Failed to cancel booking",
      });
    }
  }
);

// ========================================
// 13. VENDOR BOOKING APIs
// ========================================

// GET: Vendor Booking Requests
// Vendor Only

app.get(
  "/vendor-booking-requests",
  verifyToken,
  verifyVendor,
  async (req, res) => {
    try {
      const vendorBookings = await bookings
        .find({
          vendorId: getUserId(req.user),
        })
        .sort({ createdAt: -1 })
        .toArray();

      const bookingsWithService = await Promise.all(
        vendorBookings.map(async (booking) => {
          const service = ObjectId.isValid(booking.serviceId)
            ? await services.findOne({
                _id: new ObjectId(booking.serviceId),
              })
            : null;

          const customer = await findUserById(
            booking.customerId
          );

          return {
            ...booking,
            service: service
              ? {
                  serviceName: service.serviceName,
                  image: service.image,
                  vendorName: service.vendorName,
                }
              : null,
            customer: customer
              ? {
                  name: customer.name,
                  email: customer.email,
                  image: customer.image,
                }
              : null,
          };
        })
      );

      res.send(bookingsWithService);

    } catch (error) {
      console.error("Vendor Bookings Error:", error);

      res.status(500).send({
        message: "Failed to get booking requests",
      });
    }
  }
);

// PATCH: Accept / Reject Booking
// Vendor Only + Ownership Check

app.patch(
  "/bookings/:id/status",
  verifyToken,
  verifyVendor,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

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
          vendorId: getUserId(req.user),
          status: "pending",
        },
        {
          $set: {
            status,
            updatedAt: new Date(),
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
      console.error("Update Booking Status Error:", error);

      res.status(500).send({
        message: "Failed to update booking",
      });
    }
  }
);

// ========================================
// 14. ADMIN USER APIs
// ========================================

// GET: All Users
// Admin Only

app.get(
  "/admin/users",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { search, role } = req.query;

      // Build filters separately so search + role can be combined safely.
      const conditions = [];

      if (role === "admin") {
        conditions.push({ role: "admin" });
      } else if (role === "vendor" || role === "customer") {
        conditions.push({
          $or: [
            { accountType: role },
            { role }, // fallback for older user documents
          ],
        });
      }

      if (search && typeof search === "string") {
        conditions.push({
          $or: [
            { name: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
          ],
        });
      }

      const filter =
        conditions.length > 0 ? { $and: conditions } : {};

      const result = await users
        .find(filter)
        .project({
          name: 1,
          email: 1,
          image: 1,
          role: 1,
          accountType: 1,
          isBlocked: 1,
          businessName: 1,
          subscriptionPlan: 1,
        })
        .toArray();

      res.send(result);

    } catch (error) {
      console.error("Get Users Error:", error);

      res.status(500).send({
        message: "Failed to fetch users",
      });
    }
  }
);

// PATCH: Block / Unblock User
// Admin Only

app.patch(
  "/users/:id/block",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { isBlocked } = req.body;

      if (typeof isBlocked !== "boolean") {
        return res.status(400).send({
          message: "Invalid user status",
        });
      }

      // Works with both `_id` and legacy `id` documents.
      const user = await findUserById(id);

      if (!user) {
        return res.status(404).send({
          message: "User not found",
        });
      }

      if (user.role === "admin") {
        return res.status(403).send({
          message: "Admin cannot be blocked",
        });
      }

      await users.updateOne(
        {
          _id: user._id,
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
      console.error("Block User Error:", error);

      res.status(500).send({
        message: "Failed to update user status",
      });
    }
  }
);

// ========================================
// 15. ADMIN SERVICE APIs
// ========================================

// GET: All Submitted Services
// Admin Only

app.get(
  "/admin/services",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { search, category, status } = req.query;

      const filter = {};

      if (search && typeof search === "string") {
        filter.$or = [
          { serviceName: { $regex: search.trim(), $options: "i" } },
          { vendorName: { $regex: search.trim(), $options: "i" } },
          { vendorEmail: { $regex: search.trim(), $options: "i" } },
        ];
      }

      if (category && category !== "all") {
        filter.category = {
          $regex: `^${category.trim()}$`,
          $options: "i",
        };
      }

      if (status && status !== "all") {
        filter.status = status;
      }

      const result = await services
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();

      res.send(result);

    } catch (error) {
      console.error("Admin Services Error:", error);

      res.status(500).send({
        message: "Failed to fetch services",
      });
    }
  }
);

// DELETE: Admin Delete Service
// Admin Only

app.delete(
  "/admin/services/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
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
      console.error("Admin Delete Service Error:", error);

      res.status(500).send({
        message: "Failed to delete service",
      });
    }
  }
);

// ========================================
// 16. PROFILE APIs
// Authenticated Users
// ========================================

// GET: My Profile

app.get(
  "/profile",
  verifyToken,
  async (req, res) => {
    try {
      res.send({
        name: req.user.name,
        email: req.user.email,
        image: req.user.image,
        role: req.user.role,
        accountType: getAccountType(req.user),
        businessName: req.user.businessName,
      });

    } catch (error) {
      console.error("Profile Error:", error);

      res.status(500).send({
        message: "Failed to get profile",
      });
    }
  }
);

// PATCH: Update My Profile

app.patch(
  "/profile",
  verifyToken,
  async (req, res) => {
    try {
      const { name, image, businessName } = req.body;

      const updateData = {
        updatedAt: new Date(),
      };

      if (name !== undefined) updateData.name = name;
      if (image !== undefined) updateData.image = image;

      if (
        getAccountType(req.user) === "vendor" &&
        businessName !== undefined
      ) {
        updateData.businessName = businessName;
      }

      // Role, isBlocked and subscription cannot be changed here
      await users.updateOne(
        {
          _id: req.user._id,
        },
        {
          $set: updateData,
        }
      );

      res.send({
        success: true,
        message: "Profile updated successfully",
      });

    } catch (error) {
      console.error("Update Profile Error:", error);

      res.status(500).send({
        message: "Failed to update profile",
      });
    }
  }
);

// ========================================
// 17. STRIPE TRANSACTION APIs
// ========================================

// GET: All Transactions
// Admin Only

app.get(
  "/transactions",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const allTransactions = await transactions
        .find({})
        .sort({ createdAt: -1 })
        .toArray();

      const transactionsWithVendor = await Promise.all(
        allTransactions.map(async (transaction) => {
          const vendor = await findUserById(
            transaction.vendorId
          );

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
      console.error("Get Transactions Error:", error);

      res.status(500).send({
        success: false,
        message: "Failed to fetch transactions",
      });
    }
  }
);

// POST: Create Checkout Session
// Vendor Only

app.post(
  "/create-checkout-session",
  verifyToken,
  verifyVendor,
  async (req, res) => {
    try {
      // Get Vendor ID from verified JWT user
      const vendorId = getUserId(req.user);

      const vendor = req.user;

      if (isPremiumActive(vendor)) {
        return res.status(400).send({
          message: "You already have a Premium subscription",
        });
      }

      // Get Stripe Price
      const price = await stripe.prices.retrieve(
        process.env.STRIPE_PRICE_ID
      );

      if (!price.active || price.unit_amount === null) {
        return res.status(400).send({
          message: "Invalid or inactive Stripe price",
        });
      }

      // Create Checkout Session
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",

        // Redundant vendor reference for webhook processing.
        client_reference_id: vendorId,

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

      // Save Pending Transaction
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
  }
);

// ========================================
// 18. SERVER
// ========================================

// 

// GET: Current Subscription Status
app.get(
  "/subscription/status",
  verifyToken,
  verifyVendor,
  async (req, res) => {
    try {
      const user = await users.findOne({
        _id: req.user._id,
      });

      const premium = isPremiumActive(user);

      res.send({
        success: true,
        subscriptionPlan: premium ? "premium" : "free",
        subscriptionExpiresAt: user.subscriptionExpiresAt ?? null,
        isPremium: premium,
      });
    } catch (error) {
      console.error("Subscription Status Error:", error);

      res.status(500).send({
        message: "Failed to get subscription status",
      });
    }
  }
);

// ========================================
// PAYMENT CHECKOUT VERIFICATION
// ========================================

app.post(
  "/payments/checkout-verify",
  verifyToken,
  verifyVendor,
  async (req, res) => {
    try {
      const { sessionId } = req.body;
      const vendorId = getUserId(req.user);

      if (!sessionId) {
        return res.status(400).send({
          success: false,
          message: "Session ID is required",
        });
      }

      // Retrieve session directly from Stripe
      const session = await stripe.checkout.sessions.retrieve(
        sessionId
      );

      // Verify session owner
      const sessionVendorId =
        session.metadata?.vendorId ||
        session.client_reference_id;

      if (sessionVendorId !== vendorId) {
        return res.status(403).send({
          success: false,
          message: "Unauthorized payment session",
        });
      }

      // Verify payment
      if (
        session.status !== "complete" ||
        !["paid", "no_payment_required"].includes(
          session.payment_status
        )
      ) {
        return res.status(400).send({
          success: false,
          message: "Payment is not completed",
        });
      }

      if (
        session.mode !== "subscription" ||
        !session.subscription
      ) {
        return res.status(400).send({
          success: false,
          message: "Invalid subscription session",
        });
      }

      // Find transaction
      const transaction = await transactions.findOne({
        stripeSessionId: session.id,
        vendorId,
      });

      if (!transaction) {
        return res.status(404).send({
          success: false,
          message: "Transaction not found",
        });
      }

      // Retrieve subscription from Stripe
      const subscription = await stripe.subscriptions.retrieve(
        session.subscription
      );

      if (!["active", "trialing"].includes(subscription.status)) {
        return res.status(400).send({
          success: false,
          message: "Subscription is not active",
        });
      }

      // Activate premium
      await activatePremium({
        vendorId,
        subscription,
        context: {
          sessionId: session.id,
          source: "checkout-verify",
        },
      });

      // Update transaction
      await transactions.updateOne(
        {
          stripeSessionId: session.id,
          vendorId,
        },
        {
          $set: {
            status: "paid",
            stripeSubscriptionId: subscription.id,
            paidAt: new Date(),
          },
        }
      );

      return res.send({
        success: true,
        message: "Payment verified successfully",
        subscriptionPlan: "premium",
        subscriptionExpiresAt:
          getSubscriptionPeriodEnd(subscription),
      });

    } catch (error) {
      console.error("Checkout Verification Error:", error);

      return res.status(500).send({
        success: false,
        message: "Payment verification failed",
      });
    }
  }
);
app.listen(port, () => {
  console.log(`WedPlan Server running on port ${port}`);
});

export default app;

const express = require("express");
const path = require("path");
const dotenv = require("dotenv");
const session = require("express-session");
const passport = require("passport");
const { Strategy: GoogleStrategy } = require("passport-google-oauth20");
const Stripe = require("stripe");
const Anthropic = require("@anthropic-ai/sdk");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;


// ---------- Helpers ----------
const hasGoogleOAuth = Boolean(
  process.env.GOOGLE_CLIENT_ID &&
  process.env.GOOGLE_CLIENT_SECRET &&
  process.env.GOOGLE_CALLBACK_URL
);

function isAuthenticated(req, res, next) {
  // Si Google OAuth está desactivado, no bloqueamos la app:
  // (mientras Google Cloud esté bloqueado)
  if (!hasGoogleOAuth) return next();

  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.redirect("/auth/google");
}

// ---------- View engine + static + parsers (ANTES de rutas) ----------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Session + Passport (ANTES de rutas) ----------
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

// ---------- Passport serialize/deserialize ----------
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// ---------- Google OAuth (solo si existe) ----------
if (hasGoogleOAuth) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL,
      },
      (accessToken, refreshToken, profile, done) => done(null, profile)
    )
  );

  app.get(
    "/auth/google",
    passport.authenticate("google", { scope: ["profile", "email"] })
  );

  app.get(
    "/auth/google/callback",
    passport.authenticate("google", { failureRedirect: "/" }),
    (req, res) => res.redirect("/dashboard")
  );
} else {
  console.log("Google OAuth DESACTIVADO (faltan variables).");
}

// ---------- Stripe ----------
if (!process.env.STRIPE_SECRET_KEY) {
  console.warn("Falta STRIPE_SECRET_KEY en Secrets.");
}
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Deben ser PRICE IDs: price_...
const plans = {
  basic: process.env.STRIPE_PRICE_BASIC,
  pro: process.env.STRIPE_PRICE_PRO,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
};

// ---------- Anthropic ----------
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ---------- Pages ----------
app.get("/", (req, res) => res.render("landing", { user: req.user }));
app.get("/pricing", (req, res) =>
  res.render("pricing", { stripeKey: process.env.STRIPE_PUBLISHABLE_KEY })
);
app.get("/dashboard", isAuthenticated, (req, res) =>
  res.render("dashboard", { user: req.user })
);

app.get("/gracias", (req, res) => res.render("gracias"));
app.get("/cancelado", (req, res) => res.render("cancelado"));

app.get("/logout", (req, res) => {
  // si no hay sesión, no rompe
  if (req.logout) {
    req.logout(() => res.redirect("/"));
  } else {
    res.redirect("/");
  }
});

// ---------- Stripe Checkout ----------
app.post("/api/checkout", async (req, res) => {
  const { plan } = req.body || {};
  const priceId = plans[plan];

  if (!priceId) {
    return res.status(400).json({ error: "Plan no válido o no configurado." });
  }
  if (!process.env.APP_URL) {
    return res.status(400).json({ error: "Falta APP_URL en Secrets." });
  }

  try {
    const sessionCheckout = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.APP_URL}/gracias`,
      cancel_url: `${process.env.APP_URL}/cancelado`,
    });

    return res.json({ url: sessionCheckout.url });
  } catch (err) {
    console.error("Stripe error:", err);
    return res.status(500).json({ error: "Error al procesar el pago." });
  }
});

// ---------- IA endpoints (protegidos si hay OAuth; abiertos si no hay OAuth) ----------
app.post("/api/analyze-product", isAuthenticated, async (req, res) => {
  try {
    const { productName, category } = req.body || {};
    const prompt = `Analiza este producto para dropshipping:

Producto: ${productName}
Categoría: ${category}

Proporciona:
1. Potencial de ventas (1-10)
2. Competencia estimada
3. Precio sugerido
4. Público objetivo
5. Estrategias de marketing
6. Riesgos potenciales

Responde en formato JSON válido.`;

    const message = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    });

    return res.json({ analysis: message.content[0].text });
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: "Error al analizar producto" });
  }
});

app.post("/api/generate-content", isAuthenticated, async (req, res) => {
  try {
    const { productName, features, targetAudience } = req.body || {};
    const prompt = `Genera contenido de marketing para dropshipping:

Producto: ${productName}
Características: ${features}
Público objetivo: ${targetAudience}

Genera:
1. Título atractivo
2. Descripción del producto (100-150 palabras)
3. 3 beneficios principales
4. Call to action
5. Hashtags para redes sociales

Responde en formato JSON válido.`;

    const message = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    });

    return res.json({ content: message.content[0].text });
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: "Error al generar contenido" });
  }
});

app.post("/api/trending-products", isAuthenticated, async (req, res) => {
  try {
    const { niche } = req.body || {};
    const prompt = `Encuentra productos trending para dropshipping en el nicho: ${niche}

Proporciona 5 productos con:
1. Nombre del producto
2. Por qué está trending
3. Precio estimado
4. Dificultad de venta (1-10)
5. Margen de ganancia estimado

Responde en formato JSON válido con array de productos.`;

    const message = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });

    return res.json({ products: message.content[0].text });
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: "Error al buscar productos trending" });
  }
});

app.post("/api/competitor-analysis", isAuthenticated, async (req, res) => {
  try {
    const { productUrl, productName } = req.body || {};
    const prompt = `Analiza la competencia para este producto de dropshipping:

Producto: ${productName}
URL (si está disponible): ${productUrl}

Proporciona:
1. Estrategias de precios sugeridas
2. Ventajas competitivas a destacar
3. Puntos débiles de la competencia
4. Oportunidades de mercado
5. Recomendaciones de posicionamiento

Responde en formato JSON válido.`;

    const message = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    });

    return res.json({ analysis: message.content[0].text });
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: "Error al analizar competencia" });
  }
});

// ---------- Error handler ----------
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send("Algo salió mal, por favor intenta más tarde.");
});

// ---------- ONE listen ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en http://0.0.0.0:${PORT}`);
});

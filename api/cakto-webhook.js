// api/cakto-webhook.js

import nodemailer from "nodemailer";
import admin from "firebase-admin";

// --- 1. Inicializa Firebase Admin (só uma vez)
if (!admin.apps.length) {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (!serviceAccountJson) {
    console.error("FIREBASE_SERVICE_ACCOUNT_KEY ausente nas variáveis de ambiente!");
  }

  const serviceAccount = JSON.parse(serviceAccountJson);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const auth = admin.auth();

// --- 2. Transporter de e-mail (ajusta com seu remetente real)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.MAIL_USER, // ex: precisionxpainel@gmail.com
    pass: process.env.MAIL_PASS  // senha de app
  },
});

// --- 3. Função handler principal
export default async function handler(req, res) {
  // Liberar CORS básico pra Cakto poder bater
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).json({ ok: true, preflight: true });
  }

  // GET = healthcheck
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message: "Webhook ativo e pronto para receber POST da Cakto 🚀",
    });
  }

  // Só aceito POST pra criar usuário/enviar e-mail
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  try {
    // A Cakto manda { data: {...}, event: "...", secret: "..." }
    const { data, event, secret } = req.body || {};

    // 1. Checar segredo
    if (secret !== process.env.CAKTO_SECRET) {
      console.warn("Segredo inválido recebido:", secret);
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // 2. Checar evento
    if (event !== "purchase_approved") {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "Evento não é purchase_approved",
        eventRecebido: event,
      });
    }

    // 3. Extrair dados principais
    const email = data?.customer?.email;
    const name = data?.customer?.name || "aluno(a)";
    const productName = data?.product?.name || data?.offer?.name || "Seu Acesso";
    const orderId = data?.id;
    const checkoutUrl = data?.checkoutUrl;

    if (!email) {
      console.error("Nenhum e-mail no payload:", data);
      return res.status(400).json({ ok: false, error: "Email ausente no payload" });
    }

    // 4. Criar (ou achar) usuário no Firebase Auth
    let userRecord;
    try {
      // tenta achar primeiro
      userRecord = await auth.getUserByEmail(email);
      console.log("Usuário já existia:", userRecord.uid);
    } catch (err) {
      // se não existe, cria
      userRecord = await auth.createUser({
        email,
        password: Math.random().toString(36).slice(2, 10), // senha aleatória simples
        displayName: name,
      });
      console.log("Usuário criado:", userRecord.uid);
    }

    // 5. Enviar e-mail de boas-vindas com instruções de acesso
    const htmlBody = `
      <div style="font-family: sans-serif; font-size: 15px; color: #111;">
        <h2>Bem-vindo(a) ao ${productName} 🎯​</h2>
        <p>Oi ${name}, tudo bem?</p>
        <p>Sua compra foi confirmada com sucesso ✅</p>
        <p>Agora você já tem acesso ao painel.</p>
        <p><b>Área de acesso:</b><br/>
          <a href="https://SEU-DOMINIO-DA-AREA.com/login" target="_blank">
            https://SEU-DOMINIO-DA-AREA.com/login
          </a>
        </p>
        <p>Faça login usando este e-mail: <b>${email}</b></p>
        <p>Se for seu primeiro acesso, clique em "Esqueci minha senha"
        para definir sua senha nova.</p>

        <hr/>
        <p>Pedido: ${orderId || "-"}<br/>
        Checkout: ${checkoutUrl || "-"}</p>

        <p>Qualquer dúvida, responde este e-mail </p>
      </div>
    `;

    await transporter.sendMail({
      from: `"Painel - PrecisionX" <${process.env.MAIL_USER}>`,
      to: email,
      subject: `Seu acesso ao ${productName} está liberado ✨`,
      html: htmlBody,
    });

    // 6. Resposta final pra Cakto
    return res.status(200).json({
      ok: true,
      message: "Usuário processado e e-mail enviado.",
      email,
      uid: userRecord.uid,
      productName,
    });

  } catch (err) {
    console.error("ERRO NO WEBHOOK:", err);
    return res.status(500).json({
      ok: false,
      error: "Falha interna ao processar webhook.",
      details: err.message,
    });
  }
}

import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { saltosDeProxy } from "./lib/proxy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();

/* Proxies de confianza para req.ip (límite de intentos del login admin): ver lib/proxy.ts.
   Se registra al arrancar para poder comprobarlo en los logs de Render. */
const proxy = saltosDeProxy(process.env);
if (proxy.aviso) logger.error({ evento: "trust-proxy-invalido" }, proxy.aviso);
if (proxy.saltos > 0) app.set("trust proxy", proxy.saltos);
logger.info({ evento: "trust-proxy", saltos: proxy.saltos }, "proxies de confianza");

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  })
);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use("/uploads", express.static(path.resolve(__dirname, "../uploads")));
app.use(express.static(path.resolve(__dirname, "../public")));

/* Sin comodín que devuelva index.html: una ruta que no existe (página o API) responde 404. */
app.use("/api", router);

export default app;

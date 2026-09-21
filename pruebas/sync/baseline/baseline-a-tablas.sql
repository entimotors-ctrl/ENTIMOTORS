-- GENERADO por generar-baseline.mjs desde el catálogo real de producción (2026-09-21). NO editar a mano.
-- Solo tablas, restricciones, índices y RLS. Sin funciones (las aporta el source-sync de RCV-34).

CREATE SEQUENCE public."products_id_seq";
CREATE SEQUENCE public."project_images_id_seq";
CREATE SEQUENCE public."projects_id_seq";
CREATE SEQUENCE public."videos_id_seq";

CREATE TABLE public."abonos" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "id_abono" text NOT NULL,
  "credito_id" uuid NOT NULL,
  "monto" numeric(12,2) NOT NULL,
  "metodo_pago" text NOT NULL,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public."auditoria" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "usuario_id" uuid,
  "usuario" text,
  "rol" text,
  "accion" text NOT NULL,
  "entidad" text NOT NULL,
  "entidad_id" text,
  "detalle" text,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public."caja_movimientos" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "local_id" integer,
  "dispositivo" text,
  "tipo" text NOT NULL,
  "categoria" text,
  "monto" numeric(12,2) NOT NULL,
  "metodo_pago" text,
  "descripcion" text,
  "venta_id" uuid,
  "credito_id" uuid,
  "orden_id" uuid,
  "id_abono" text,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public."categorias_inv" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "local_id" integer,
  "dispositivo" text,
  "nombre" text NOT NULL,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public."citas" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "local_id" integer,
  "dispositivo" text,
  "cliente_id" uuid,
  "nombre_tmp" text,
  "telefono_tmp" text,
  "fecha" date NOT NULL,
  "hora" text NOT NULL,
  "mecanico" text,
  "motivo" text,
  "origen" text,
  "estado" text,
  "cerrada_en" timestamp with time zone,
  "orden_id" uuid,
  "recordatorio_enviado" boolean NOT NULL DEFAULT false,
  "reprogramaciones" jsonb,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now(),
  "aviso_cliente_wa" jsonb,
  "mecanico_id" uuid
);

CREATE TABLE public."clientes" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "local_id" integer,
  "dispositivo" text,
  "nombre" text NOT NULL,
  "telefono" text,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now(),
  "actualizado_en" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public."cotizacion_items" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "cotizacion_id" uuid NOT NULL,
  "inventario_id" uuid,
  "nombre" text NOT NULL,
  "cantidad" numeric(12,2) NOT NULL,
  "precio" numeric(12,2) NOT NULL
);

CREATE TABLE public."cotizaciones" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "local_id" integer,
  "dispositivo" text,
  "cliente_id" uuid,
  "cliente_nombre" text NOT NULL,
  "cliente_telefono" text,
  "moto_id" uuid,
  "moto_desc" text,
  "diagnostico" text,
  "notas" text,
  "validez_dias" integer NOT NULL DEFAULT 15,
  "vence_en" timestamp with time zone NOT NULL,
  "estado" text NOT NULL DEFAULT 'pendiente'::text,
  "orden_id" uuid,
  "creado_por" text,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public."credito_items" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "credito_id" uuid NOT NULL,
  "inventario_id" uuid,
  "nombre" text NOT NULL,
  "cantidad" numeric(12,2) NOT NULL,
  "precio" numeric(12,2) NOT NULL,
  "costo_unitario" numeric(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE public."creditos" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "local_id" integer,
  "dispositivo" text,
  "cliente_id" uuid,
  "cliente_nombre" text NOT NULL,
  "cliente_telefono" text,
  "total" numeric(12,2) NOT NULL,
  "abonado" numeric(12,2) NOT NULL DEFAULT 0,
  "saldo" numeric(12,2) NOT NULL,
  "estado" text NOT NULL DEFAULT 'pendiente'::text,
  "origen" text,
  "orden_id" uuid,
  "nota" text,
  "vencimiento" date,
  "mecanico" text,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public."inventario" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "local_id" integer,
  "dispositivo" text,
  "nombre" text NOT NULL,
  "modelo" text,
  "categoria_id" uuid,
  "cantidad" numeric(12,2) NOT NULL DEFAULT 0,
  "costo_compra" numeric(12,2) NOT NULL DEFAULT 0,
  "precio_venta" numeric(12,2) NOT NULL DEFAULT 0,
  "stock_minimo" numeric(12,2) NOT NULL DEFAULT 3,
  "codigo_barras" text,
  "publicar_en_web" boolean NOT NULL DEFAULT false,
  "foto_url" text,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public."motos" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "local_id" integer,
  "dispositivo" text,
  "cliente_id" uuid,
  "marca" text,
  "modelo" text,
  "placa" text,
  "km" integer DEFAULT 0,
  "ultimo_mantenimiento" timestamp with time zone,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public."orden_items" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "orden_id" uuid NOT NULL,
  "inventario_id" uuid,
  "nombre" text NOT NULL,
  "cantidad" numeric(12,2) NOT NULL,
  "precio" numeric(12,2) NOT NULL,
  "costo_unitario" numeric(12,2) NOT NULL DEFAULT 0,
  "costo_estimado" boolean NOT NULL DEFAULT false
);

CREATE TABLE public."ordenes" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "local_id" integer,
  "dispositivo" text,
  "cliente_id" uuid,
  "moto_id" uuid,
  "estado" text NOT NULL DEFAULT 'recibido'::text,
  "falla" text,
  "diagnostico" jsonb,
  "reparacion_notas" text,
  "calidad_checklist" jsonb,
  "fotos" jsonb,
  "aprobacion" jsonb,
  "mecanico" text,
  "cita_local_id" integer,
  "cotizacion_local_id" integer,
  "finalizada" boolean NOT NULL DEFAULT false,
  "finalizado_en" timestamp with time zone,
  "entregado_en" timestamp with time zone,
  "margen" numeric(6,2),
  "tipo_cobro" text,
  "metodo_pago" text,
  "garantia_dias" integer,
  "km_salida" integer,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now(),
  "origen_trabajo" text NOT NULL DEFAULT 'taller'::text,
  "mecanico_id" uuid
);

CREATE TABLE public."perfiles" (
  "id" uuid NOT NULL,
  "nombre" text NOT NULL,
  "rol" text NOT NULL DEFAULT 'mecanico'::text,
  "telefono" text,
  "activo" boolean NOT NULL DEFAULT true,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public."products" (
  "id" bigint NOT NULL DEFAULT nextval('products_id_seq'::regclass),
  "name" text NOT NULL,
  "price" numeric(10,2) NOT NULL,
  "image" text,
  "category" text NOT NULL DEFAULT 'repuesto'::text,
  "created_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE public."project_images" (
  "id" integer NOT NULL DEFAULT nextval('project_images_id_seq'::regclass),
  "project_id" integer NOT NULL,
  "image_url" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE public."projects" (
  "id" bigint NOT NULL DEFAULT nextval('projects_id_seq'::regclass),
  "title" text NOT NULL,
  "image" text,
  "status" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE public."venta_items" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "venta_id" uuid NOT NULL,
  "inventario_id" uuid,
  "nombre" text NOT NULL,
  "cantidad" numeric(12,2) NOT NULL,
  "precio" numeric(12,2) NOT NULL,
  "costo_unitario" numeric(12,2) NOT NULL DEFAULT 0,
  "costo_estimado" boolean NOT NULL DEFAULT false
);

CREATE TABLE public."ventas" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "local_id" integer,
  "dispositivo" text,
  "cliente_id" uuid,
  "cliente_nombre" text,
  "metodo_pago" text NOT NULL,
  "total" numeric(12,2) NOT NULL,
  "efectivo_recibido" numeric(12,2),
  "cambio" numeric(12,2),
  "mecanico" text,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public."videos" (
  "id" bigint NOT NULL DEFAULT nextval('videos_id_seq'::regclass),
  "title" text NOT NULL,
  "url" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE public."web_cms" (
  "clave" text NOT NULL,
  "valor" jsonb,
  "actualizado_en" timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public."abonos" ADD CONSTRAINT "abonos_pkey" PRIMARY KEY (id);
ALTER TABLE public."auditoria" ADD CONSTRAINT "auditoria_pkey" PRIMARY KEY (id);
ALTER TABLE public."caja_movimientos" ADD CONSTRAINT "caja_movimientos_pkey" PRIMARY KEY (id);
ALTER TABLE public."categorias_inv" ADD CONSTRAINT "categorias_inv_pkey" PRIMARY KEY (id);
ALTER TABLE public."citas" ADD CONSTRAINT "citas_pkey" PRIMARY KEY (id);
ALTER TABLE public."clientes" ADD CONSTRAINT "clientes_pkey" PRIMARY KEY (id);
ALTER TABLE public."cotizacion_items" ADD CONSTRAINT "cotizacion_items_pkey" PRIMARY KEY (id);
ALTER TABLE public."cotizaciones" ADD CONSTRAINT "cotizaciones_pkey" PRIMARY KEY (id);
ALTER TABLE public."credito_items" ADD CONSTRAINT "credito_items_pkey" PRIMARY KEY (id);
ALTER TABLE public."creditos" ADD CONSTRAINT "creditos_pkey" PRIMARY KEY (id);
ALTER TABLE public."inventario" ADD CONSTRAINT "inventario_pkey" PRIMARY KEY (id);
ALTER TABLE public."motos" ADD CONSTRAINT "motos_pkey" PRIMARY KEY (id);
ALTER TABLE public."orden_items" ADD CONSTRAINT "orden_items_pkey" PRIMARY KEY (id);
ALTER TABLE public."ordenes" ADD CONSTRAINT "ordenes_pkey" PRIMARY KEY (id);
ALTER TABLE public."perfiles" ADD CONSTRAINT "perfiles_pkey" PRIMARY KEY (id);
ALTER TABLE public."products" ADD CONSTRAINT "products_pkey" PRIMARY KEY (id);
ALTER TABLE public."project_images" ADD CONSTRAINT "project_images_pkey" PRIMARY KEY (id);
ALTER TABLE public."projects" ADD CONSTRAINT "projects_pkey" PRIMARY KEY (id);
ALTER TABLE public."venta_items" ADD CONSTRAINT "venta_items_pkey" PRIMARY KEY (id);
ALTER TABLE public."ventas" ADD CONSTRAINT "ventas_pkey" PRIMARY KEY (id);
ALTER TABLE public."videos" ADD CONSTRAINT "videos_pkey" PRIMARY KEY (id);
ALTER TABLE public."web_cms" ADD CONSTRAINT "web_cms_pkey" PRIMARY KEY (clave);
ALTER TABLE public."abonos" ADD CONSTRAINT "abonos_id_abono_key" UNIQUE (id_abono);
ALTER TABLE public."caja_movimientos" ADD CONSTRAINT "caja_movimientos_dispositivo_local_id_key" UNIQUE (dispositivo, local_id);
ALTER TABLE public."categorias_inv" ADD CONSTRAINT "categorias_inv_dispositivo_local_id_key" UNIQUE (dispositivo, local_id);
ALTER TABLE public."citas" ADD CONSTRAINT "citas_dispositivo_local_id_key" UNIQUE (dispositivo, local_id);
ALTER TABLE public."clientes" ADD CONSTRAINT "clientes_dispositivo_local_id_key" UNIQUE (dispositivo, local_id);
ALTER TABLE public."cotizaciones" ADD CONSTRAINT "cotizaciones_dispositivo_local_id_key" UNIQUE (dispositivo, local_id);
ALTER TABLE public."creditos" ADD CONSTRAINT "creditos_dispositivo_local_id_key" UNIQUE (dispositivo, local_id);
ALTER TABLE public."inventario" ADD CONSTRAINT "inventario_dispositivo_local_id_key" UNIQUE (dispositivo, local_id);
ALTER TABLE public."motos" ADD CONSTRAINT "motos_dispositivo_local_id_key" UNIQUE (dispositivo, local_id);
ALTER TABLE public."ordenes" ADD CONSTRAINT "ordenes_dispositivo_local_id_key" UNIQUE (dispositivo, local_id);
ALTER TABLE public."ventas" ADD CONSTRAINT "ventas_dispositivo_local_id_key" UNIQUE (dispositivo, local_id);
ALTER TABLE public."abonos" ADD CONSTRAINT "abonos_monto_check" CHECK (monto > 0::numeric);
ALTER TABLE public."caja_movimientos" ADD CONSTRAINT "caja_movimientos_monto_check" CHECK (monto >= 0::numeric);
ALTER TABLE public."caja_movimientos" ADD CONSTRAINT "caja_movimientos_tipo_check" CHECK (tipo = ANY (ARRAY['ingreso'::text, 'egreso'::text]));
ALTER TABLE public."cotizacion_items" ADD CONSTRAINT "cotizacion_items_cantidad_check" CHECK (cantidad > 0::numeric);
ALTER TABLE public."cotizacion_items" ADD CONSTRAINT "cotizacion_items_precio_check" CHECK (precio >= 0::numeric);
ALTER TABLE public."cotizaciones" ADD CONSTRAINT "cotizaciones_estado_check" CHECK (estado = ANY (ARRAY['pendiente'::text, 'aceptada'::text, 'rechazada'::text]));
ALTER TABLE public."cotizaciones" ADD CONSTRAINT "cotizaciones_validez_dias_check" CHECK (validez_dias > 0);
ALTER TABLE public."credito_items" ADD CONSTRAINT "credito_items_cantidad_check" CHECK (cantidad > 0::numeric);
ALTER TABLE public."credito_items" ADD CONSTRAINT "credito_items_precio_check" CHECK (precio >= 0::numeric);
ALTER TABLE public."creditos" ADD CONSTRAINT "creditos_abonado_check" CHECK (abonado >= 0::numeric);
ALTER TABLE public."creditos" ADD CONSTRAINT "creditos_estado_check" CHECK (estado = ANY (ARRAY['pendiente'::text, 'parcial'::text, 'pagado'::text]));
ALTER TABLE public."creditos" ADD CONSTRAINT "creditos_total_check" CHECK (total >= 0::numeric);
ALTER TABLE public."creditos" ADD CONSTRAINT "saldo_cuadra" CHECK (abs(saldo - (total - abonado)) < 0.01);
ALTER TABLE public."inventario" ADD CONSTRAINT "inventario_cantidad_check" CHECK (cantidad >= 0::numeric);
ALTER TABLE public."inventario" ADD CONSTRAINT "inventario_costo_compra_check" CHECK (costo_compra >= 0::numeric);
ALTER TABLE public."inventario" ADD CONSTRAINT "inventario_precio_venta_check" CHECK (precio_venta >= 0::numeric);
ALTER TABLE public."orden_items" ADD CONSTRAINT "orden_items_cantidad_check" CHECK (cantidad > 0::numeric);
ALTER TABLE public."orden_items" ADD CONSTRAINT "orden_items_precio_check" CHECK (precio >= 0::numeric);
ALTER TABLE public."ordenes" ADD CONSTRAINT "ordenes_estado_check" CHECK (estado = ANY (ARRAY['recibido'::text, 'diagnostico'::text, 'presupuesto'::text, 'reparacion'::text, 'calidad'::text, 'entregado'::text]));
ALTER TABLE public."ordenes" ADD CONSTRAINT "ordenes_origen_trabajo_check" CHECK (origen_trabajo = ANY (ARRAY['taller'::text, 'negocio'::text]));
ALTER TABLE public."ordenes" ADD CONSTRAINT "ordenes_tipo_cobro_check" CHECK (tipo_cobro = ANY (ARRAY['contado'::text, 'credito'::text]));
ALTER TABLE public."perfiles" ADD CONSTRAINT "perfiles_rol_check" CHECK (rol = ANY (ARRAY['admin'::text, 'mecanico'::text, 'cajero'::text, 'desarrollador'::text]));
ALTER TABLE public."products" ADD CONSTRAINT "products_category_check" CHECK (category = ANY (ARRAY['repuesto'::text, 'accesorio'::text]));
ALTER TABLE public."projects" ADD CONSTRAINT "projects_status_check" CHECK (status = ANY (ARRAY['en_curso'::text, 'terminado'::text]));
ALTER TABLE public."venta_items" ADD CONSTRAINT "venta_items_cantidad_check" CHECK (cantidad > 0::numeric);
ALTER TABLE public."venta_items" ADD CONSTRAINT "venta_items_precio_check" CHECK (precio >= 0::numeric);
ALTER TABLE public."ventas" ADD CONSTRAINT "ventas_total_check" CHECK (total >= 0::numeric);
ALTER TABLE public."abonos" ADD CONSTRAINT "abonos_credito_id_fkey" FOREIGN KEY (credito_id) REFERENCES creditos(id) ON DELETE CASCADE;
ALTER TABLE public."auditoria" ADD CONSTRAINT "auditoria_usuario_id_fkey" FOREIGN KEY (usuario_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public."caja_movimientos" ADD CONSTRAINT "caja_movimientos_credito_id_fkey" FOREIGN KEY (credito_id) REFERENCES creditos(id) ON DELETE SET NULL;
ALTER TABLE public."caja_movimientos" ADD CONSTRAINT "caja_movimientos_orden_id_fkey" FOREIGN KEY (orden_id) REFERENCES ordenes(id) ON DELETE SET NULL;
ALTER TABLE public."caja_movimientos" ADD CONSTRAINT "caja_movimientos_venta_id_fkey" FOREIGN KEY (venta_id) REFERENCES ventas(id) ON DELETE SET NULL;
ALTER TABLE public."citas" ADD CONSTRAINT "citas_cliente_id_fkey" FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE SET NULL;
ALTER TABLE public."citas" ADD CONSTRAINT "citas_mecanico_id_fkey" FOREIGN KEY (mecanico_id) REFERENCES perfiles(id) ON DELETE SET NULL;
ALTER TABLE public."citas" ADD CONSTRAINT "citas_orden_id_fkey" FOREIGN KEY (orden_id) REFERENCES ordenes(id) ON DELETE SET NULL;
ALTER TABLE public."cotizacion_items" ADD CONSTRAINT "cotizacion_items_cotizacion_id_fkey" FOREIGN KEY (cotizacion_id) REFERENCES cotizaciones(id) ON DELETE CASCADE;
ALTER TABLE public."cotizacion_items" ADD CONSTRAINT "cotizacion_items_inventario_id_fkey" FOREIGN KEY (inventario_id) REFERENCES inventario(id) ON DELETE SET NULL;
ALTER TABLE public."cotizaciones" ADD CONSTRAINT "cotizaciones_cliente_id_fkey" FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE SET NULL;
ALTER TABLE public."cotizaciones" ADD CONSTRAINT "cotizaciones_moto_id_fkey" FOREIGN KEY (moto_id) REFERENCES motos(id) ON DELETE SET NULL;
ALTER TABLE public."cotizaciones" ADD CONSTRAINT "cotizaciones_orden_id_fkey" FOREIGN KEY (orden_id) REFERENCES ordenes(id) ON DELETE SET NULL;
ALTER TABLE public."credito_items" ADD CONSTRAINT "credito_items_credito_id_fkey" FOREIGN KEY (credito_id) REFERENCES creditos(id) ON DELETE CASCADE;
ALTER TABLE public."credito_items" ADD CONSTRAINT "credito_items_inventario_id_fkey" FOREIGN KEY (inventario_id) REFERENCES inventario(id) ON DELETE SET NULL;
ALTER TABLE public."creditos" ADD CONSTRAINT "creditos_cliente_id_fkey" FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE RESTRICT;
ALTER TABLE public."creditos" ADD CONSTRAINT "creditos_orden_id_fkey" FOREIGN KEY (orden_id) REFERENCES ordenes(id) ON DELETE SET NULL;
ALTER TABLE public."inventario" ADD CONSTRAINT "inventario_categoria_id_fkey" FOREIGN KEY (categoria_id) REFERENCES categorias_inv(id) ON DELETE SET NULL;
ALTER TABLE public."motos" ADD CONSTRAINT "motos_cliente_id_fkey" FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE;
ALTER TABLE public."orden_items" ADD CONSTRAINT "orden_items_inventario_id_fkey" FOREIGN KEY (inventario_id) REFERENCES inventario(id) ON DELETE SET NULL;
ALTER TABLE public."orden_items" ADD CONSTRAINT "orden_items_orden_id_fkey" FOREIGN KEY (orden_id) REFERENCES ordenes(id) ON DELETE CASCADE;
ALTER TABLE public."ordenes" ADD CONSTRAINT "ordenes_cliente_id_fkey" FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE RESTRICT;
ALTER TABLE public."ordenes" ADD CONSTRAINT "ordenes_mecanico_id_fkey" FOREIGN KEY (mecanico_id) REFERENCES perfiles(id) ON DELETE SET NULL;
ALTER TABLE public."ordenes" ADD CONSTRAINT "ordenes_moto_id_fkey" FOREIGN KEY (moto_id) REFERENCES motos(id) ON DELETE RESTRICT;
ALTER TABLE public."perfiles" ADD CONSTRAINT "perfiles_id_fkey" FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public."project_images" ADD CONSTRAINT "project_images_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE public."venta_items" ADD CONSTRAINT "venta_items_inventario_id_fkey" FOREIGN KEY (inventario_id) REFERENCES inventario(id) ON DELETE SET NULL;
ALTER TABLE public."venta_items" ADD CONSTRAINT "venta_items_venta_id_fkey" FOREIGN KEY (venta_id) REFERENCES ventas(id) ON DELETE CASCADE;
ALTER TABLE public."ventas" ADD CONSTRAINT "ventas_cliente_id_fkey" FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE SET NULL;

CREATE INDEX idx_abonos_credito ON public.abonos USING btree (credito_id);
CREATE INDEX idx_auditoria_creado ON public.auditoria USING btree (creado_en DESC);
CREATE INDEX idx_caja_creado ON public.caja_movimientos USING btree (creado_en DESC);
CREATE INDEX citas_mecanico_id_idx ON public.citas USING btree (mecanico_id) WHERE (mecanico_id IS NOT NULL);
CREATE INDEX idx_citas_cliente ON public.citas USING btree (cliente_id);
CREATE INDEX idx_citas_fecha ON public.citas USING btree (fecha);
CREATE INDEX idx_cotiz_estado ON public.cotizaciones USING btree (estado);
CREATE INDEX idx_creditos_cliente ON public.creditos USING btree (cliente_id);
CREATE INDEX idx_creditos_estado ON public.creditos USING btree (estado);
CREATE INDEX idx_motos_cliente ON public.motos USING btree (cliente_id);
CREATE INDEX idx_orden_items_ord ON public.orden_items USING btree (orden_id);
CREATE INDEX idx_ordenes_cliente ON public.ordenes USING btree (cliente_id);
CREATE INDEX idx_ordenes_estado ON public.ordenes USING btree (estado);
CREATE INDEX idx_ordenes_moto ON public.ordenes USING btree (moto_id);
CREATE INDEX ordenes_mecanico_id_idx ON public.ordenes USING btree (mecanico_id) WHERE (mecanico_id IS NOT NULL);
CREATE INDEX idx_venta_items_vta ON public.venta_items USING btree (venta_id);

ALTER TABLE public."abonos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."auditoria" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."caja_movimientos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."categorias_inv" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."citas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."clientes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."cotizacion_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."cotizaciones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."credito_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."creditos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."inventario" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."motos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."orden_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ordenes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."perfiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."project_images" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."venta_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ventas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."videos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."web_cms" ENABLE ROW LEVEL SECURITY;

COMMENT ON COLUMN public."citas"."mecanico" IS 'Nombre visible del mecánico. Se conserva siempre, también cuando mecanico_id está puesto: es el historial y el fallback.';
COMMENT ON COLUMN public."citas"."mecanico_id" IS 'Perfil asignado. Null = trabajador sin cuenta, registro anterior a 4C, o sin asignar. El nombre visible está en citas.mecanico.';
COMMENT ON COLUMN public."ordenes"."mecanico" IS 'Nombre visible del mecánico. Se conserva siempre, también cuando mecanico_id está puesto: es el historial y el fallback.';
COMMENT ON COLUMN public."ordenes"."mecanico_id" IS 'Perfil asignado. Null = trabajador sin cuenta, registro anterior a 4C, o sin asignar. El nombre visible está en ordenes.mecanico.';

REVOKE ALL ON TABLE public."abonos" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."abonos" TO authenticated;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."abonos" TO service_role;
REVOKE ALL ON TABLE public."auditoria" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."auditoria" TO authenticated;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."auditoria" TO service_role;
REVOKE ALL ON TABLE public."caja_movimientos" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."caja_movimientos" TO authenticated;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."caja_movimientos" TO service_role;
REVOKE ALL ON TABLE public."categorias_inv" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."categorias_inv" TO authenticated;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."categorias_inv" TO service_role;
REVOKE ALL ON TABLE public."citas" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."citas" TO authenticated;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."citas" TO service_role;
REVOKE ALL ON TABLE public."clientes" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."clientes" TO authenticated;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."clientes" TO service_role;
REVOKE ALL ON TABLE public."cotizacion_items" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."cotizacion_items" TO authenticated;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."cotizacion_items" TO service_role;
REVOKE ALL ON TABLE public."cotizaciones" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."cotizaciones" TO authenticated;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."cotizaciones" TO service_role;
REVOKE ALL ON TABLE public."credito_items" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."credito_items" TO authenticated;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."credito_items" TO service_role;
REVOKE ALL ON TABLE public."creditos" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."creditos" TO authenticated;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."creditos" TO service_role;
REVOKE ALL ON TABLE public."inventario" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."inventario" TO authenticated;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."inventario" TO service_role;
REVOKE ALL ON TABLE public."motos" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."motos" TO authenticated;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."motos" TO service_role;
REVOKE ALL ON TABLE public."orden_items" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."orden_items" TO authenticated;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."orden_items" TO service_role;
REVOKE ALL ON TABLE public."ordenes" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ordenes" TO authenticated;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ordenes" TO service_role;
REVOKE ALL ON TABLE public."perfiles" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."perfiles" TO authenticated;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."perfiles" TO service_role;
REVOKE ALL ON TABLE public."products" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."products" TO service_role;
REVOKE ALL ON TABLE public."project_images" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."project_images" TO service_role;
REVOKE ALL ON TABLE public."projects" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."projects" TO service_role;
REVOKE ALL ON TABLE public."venta_items" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."venta_items" TO authenticated;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."venta_items" TO service_role;
REVOKE ALL ON TABLE public."ventas" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ventas" TO authenticated;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ventas" TO service_role;
REVOKE ALL ON TABLE public."videos" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."videos" TO service_role;
REVOKE ALL ON TABLE public."web_cms" FROM anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."web_cms" TO authenticated;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."web_cms" TO service_role;

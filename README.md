# Baby Ginos · Ads Reader 🍼📊

App de **solo lectura** que baja tus anuncios de Meta todos los días, guarda el
histórico y te avisa por Telegram cuáles son ganadores y cuáles se están agotando.
**No toca tu cuenta:** no pausa, no cancela, no mueve nada. Solo lee e informa.

---

## Qué hace, en un vistazo

1. Baja las métricas diarias de cada anuncio (gasto, CPM, frecuencia, CTR, resultados).
2. Las guarda en Supabase (así tiene memoria = puede calcular el baseline de cada anuncio).
3. Clasifica cada anuncio en funnel (TOF / MOF / BOF).
4. Detecta fatiga: compara "los últimos 3 días" contra "la semana 1" del anuncio.
   Con 2 de 3 señales en rojo (frecuencia↑, CTR↓, CPM↑) → lo marca *fatigando*.
5. Te manda un resumen diario por Telegram.

---

## Reparto de tareas

| Parte | Quién |
|-------|-------|
| Crear la app en Meta y generar el token | **Vos** (lleva tu login, es secreto) |
| Todo el código | Ya está hecho (esta carpeta) |
| Pegar el esquema en Supabase | Vos (copy-paste, 2 min) |
| Cargar las llaves y desplegar en Netlify | Vos (copy-paste, 5 min) |

---

## Paso 1 · Meta (solo vos podés)

1. Entrá a **developers.facebook.com** → *Mis apps* → *Crear app* → tipo **Business**.
2. Abrí **Graph API Explorer**, elegí tu app, agregá el permiso **`ads_read`**
   y generá el *Access Token*.
3. Anotá tu **id de cuenta** (empieza con `act_`). Lo ves en la URL del Administrador
   de Anuncios o poniendo `me/adaccounts` en el Explorer.
4. **Prueba rápida** (pegá en el Explorer, cambiando `act_XXXX`):

   ```
   act_XXXX/insights?level=ad&fields=ad_name,spend,cpm,frequency,ctr&date_preset=last_7d
   ```

   Si devuelve un JSON con tus anuncios → todo bien.

> ⚠️ El token es una llave privada. Va **solo** en las variables de entorno de
> Netlify. Nunca en el código, nunca compartido por chat.

---

## Paso 2 · Supabase

1. En **supabase.com** creá un proyecto (o usá el de la app de stock).
2. Andá a **SQL Editor** → pegá todo `supabase-schema.sql` → **Run**.
3. En **Project settings → API** copiá:
   - `Project URL`  → será `SUPABASE_URL`
   - `service_role` key (la secreta) → será `SUPABASE_SERVICE_KEY`

---

## Paso 3 · Telegram (canal gratis del resumen)

1. En Telegram, escribile a **@BotFather** → `/newbot` → seguí los pasos.
   Te da el **BOT_TOKEN**.
2. Escribile algo a tu bot nuevo. Después abrí en el navegador:
   `https://api.telegram.org/bot<TU_BOT_TOKEN>/getUpdates`
   y buscá tu **chat id** (campo `"chat":{"id": ...}`).

---

## Paso 4 · Netlify (desplegar)

1. Subí esta carpeta a un repo (GitHub) y conectala en Netlify,
   **o** arrastrala en *Deploys*.
2. En **Site settings → Environment variables** cargá todas las del
   `.env.example` con tus valores reales.
3. Netlify detecta la función programada sola (por el `schedule` en `sync-ads.mjs`).
   Corre todos los días ~08:00 AR.
4. Para probarla ya mismo: entrá a la función en Netlify y ejecutala manualmente
   (*Trigger* / *Run*), o pegá su URL en el navegador.

---

## Ajustes que vas a querer tocar

En `netlify/functions/lib/rules.mjs`, arriba de todo (`CONFIG`):

- `CPA_MAX` → **poné tu costo por resultado máximo real** (hoy está en 9999 para no filtrar).
- `FREQ_CEILING`, `CTR_DROP_PCT`, `CPM_RISE_PCT` → los umbrales de fatiga.
- `BASELINE_DAYS`, `SHORT_WINDOW_DAYS` → las ventanas larga y corta.

Y en el `.env`: `RESULT_ACTION_TYPE` (por defecto `purchase`; cambialo si tu
objetivo es otro, ej. `lead`).

---

## Costo

- Meta API: gratis · Netlify: gratis (functions incluidas) · Telegram: gratis
- Supabase: gratis para probar; ~US$25/mes si querés el plan Pro sólido en producción.

import { createApp, analytics, server, serving } from '@databricks/appkit';
import { aimapper } from './aimapper/index.js';

// analytics() declares the SQL warehouse resource (DATABRICKS_WAREHOUSE_ID) and
// serving() the LLM endpoint; the aimapper plugin owns all Databricks calls
// (UC listing, serving query, statement execution for target-schema/history/examples) via
// OBO, with env-driven catalog/schema.
createApp({
  plugins: [
    analytics(),
    server(),
    serving(),
    aimapper(),
  ],
}).catch(console.error);

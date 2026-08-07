/** Resume pipeline drain after a server restart. */
import { drainPipeline } from "../src/lib/pipeline/drain";

drainPipeline({ budgetMs: 720_000 })
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

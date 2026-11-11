import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { verificarChecksums } from "../src/domain/fixtures.js"

const problemas = await verificarChecksums(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures"))
if (problemas.length) {
  console.error(`Fixtures alterados: ${problemas.join(", ")}`)
  process.exit(1)
}
console.log("Fixtures íntegros (CHECKSUMS.sha256 OK)")

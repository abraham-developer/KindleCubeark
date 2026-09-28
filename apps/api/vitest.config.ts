import { defineConfig } from 'vitest/config'

export default defineConfig({
  // los tests comparten una sola base Postgres: los archivos deben correr en
  // serie (resetDb trunca tablas y puede borrar usuarios de otro archivo a
  // mitad de suite). La opción a nivel raíz no surte efecto en vitest 2.1.9;
  // dentro de `test` sí.
  test: {
    fileParallelism: false,
  },
})

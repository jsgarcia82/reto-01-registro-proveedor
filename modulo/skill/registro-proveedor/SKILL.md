---
name: registro-proveedor
description: Reglas del proceso de registro como proveedor de Periferia (estados de campo, identificador tributario por país, vigencias de soportes, datos bancarios, formatos y envío con confirmación).
---
# Proceso de registro como proveedor

## Flujo
Recepción deposita el correo del cliente → la analista pide al agente procesar el caso → el agente prepara formulario y paquete → la analista revisa faltantes y confirma → el representante legal firma (fuera del sistema).

## Estados de un campo
- **lleno**: el valor existe en el repositorio maestro (se indica la ruta del dato).
- **faltante**: no existe en el maestro. No bloquea la firma, pero aparece en el checklist.
- **requiere_confirmacion**: mapeo con confianza < 0.8 o regla de país.

## Identificador tributario por país (RN1)
| País | Identificador |
|---|---|
| Colombia (CO) | NIT |
| Ecuador (EC), Perú (PE), Panamá (PA) | RUC |
| Honduras (HN) | RTN |

Periferia solo tiene NIT colombiano: en otros países el campo se llena con el NIT y queda en *requiere_confirmacion* con la nota "identificador extranjero".

## Soportes (RN3)
- Un soporte con `vigencia_hasta` anterior a la fecha de referencia está **vencido** y bloquea `listo_para_firma`.
- Un soporte exigido que no existe en el repositorio está **ausente** y bloquea `listo_para_firma`.
- Un campo faltante **no** bloquea.

## Datos bancarios (RN2)
Se llenan solo si la plantilla los pide. Nunca van en el borrador de correo ni en el chat.

## Formatos de salida
- **xlsx**: se escribe cada valor en la hoja y celda indicadas.
- **pdf**: se rellenan los campos del formulario en el orden dado.
- **portal web**: no soportado; se generan los valores listos para copiar. Credenciales y clic final son humanos.

## Envío (RN4)
Enviar solo escribe `ENVIO-SIMULADO.md` y requiere confirmación humana explícita en la interfaz, ligada a la versión exacta del paquete.

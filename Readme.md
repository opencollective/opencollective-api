API colectiva abierta
Estado de dependencia CI E2E

Prefacio
Si ve un paso a continuación que podría mejorarse (o está desactualizado), actualice las instrucciones. Rara vez pasamos por este proceso nosotros mismos, por lo que su nuevo par de ojos y su experiencia reciente con él, lo convierte en el mejor candidato para mejorarlos para otros usuarios. ¡Gracias!

Desarrollo
Requisito previo
Asegúrese de tener la versión de Node.js> = 10.
Recomendamos el uso de NVM : nvm use.
Asegúrese de tener una base de datos PostgreSQL disponible
Verifique la versión: 11.0, 10.3, 9.6.8, 9.5.12, 9.4.17, 9.3.22 o más reciente
Verifique que la extensión PostGIS esté disponible
Más información en nuestra documentación de base de datos PostgreSQL
Para node-gyp , asegúrese de tener Python 2 disponible y configurado como la versión activa.
Puede usar pyenv para administrar versiones de Python.
Instalar en pc
Recomendamos clonar el repositorio en una carpeta dedicada a opencollectiveproyectos.

git clone git@github.com:opencollective/opencollective-api.git opencollective/api
cd opencollective/api
npm install
comienzo
npm run dev
La API se inicia en http: // localhost: 3060
Se inicia una bandeja de entrada de correo electrónico local en http: // localhost: 1080
Solución de problemas
Si tiene node-gypproblemas relacionados con Python 3 vs Python 2, puede ejecutar:npm rebuild
Si tiene problemas con PostgreSQL, consulte nuestra documentación dedicada
Despliegue
Resumen : este proyecto está actualmente implementado en etapa de pruebas y producción con Heroku . Para implementar, debe ser un miembro principal del equipo de Open Collective.

Ver: docs / deployment.md

Más documentación:
Base de datos PostgreSQL
Lista de variables de entorno compatibles
Desarrollando con correos electrónicos
Exportaciones de datos
Discusión
Si tiene alguna pregunta, envíenos un ping en Slack ( https://slack.opencollective.com ) o en Twitter ( @opencollect ).

Lanzamientos
 228 etiquetas
Patrocine este proyecto
open_collective
opencollective.com/ opencollective

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'development';
}

if (process.env.NODE_ENV === 'development') {
  const PG_DATABASE = 'opencollective_test';
  const API_PORT = 3061;

  console.log(`Setting PG_DATABASE=${PG_DATABASE}`);
  process.env.PG_DATABASE = PG_DATABASE;

  console.log(`Setting API_PORT=${API_PORT}`);
  process.env.API_PORT = API_PORT;

  require('dotenv').load();
}
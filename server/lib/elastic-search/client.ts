import { Client } from '@elastic/elasticsearch';

export const getElasticSearchClient = () => {
  return new Client({
    node: 'http://localhost:9200',
    // auth: {
    //   username: 'elastic',
    //   password: '<ES_PASSWORD>',
    // },
  });
};

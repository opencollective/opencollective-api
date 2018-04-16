import { setWorldConstructor } from 'cucumber';
import TransactionWorld from './world_transaction';

class CustomWorld {
  constructor() {
    this.transaction = new TransactionWorld;
  }
}

setWorldConstructor(CustomWorld);

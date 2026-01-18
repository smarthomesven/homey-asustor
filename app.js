'use strict';

const Homey = require('homey');

module.exports = class MyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('ASUSTOR app has been initialized');
  }

  async onUninit() {
    this.log('ASUSTOR app is being uninitialized');
  }

};

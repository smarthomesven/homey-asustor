'use strict';

const Homey = require('homey');

module.exports = class NASDevice extends Homey.Device {

  async onInit() {
    this.log('NAS has been initialized');
    
    // Only register flow cards if not already registered
    if (!this.flowCardsRegistered) {  
      const lanCondition = this.homey.flow.getConditionCard("lan_port_connected");
      lanCondition.registerRunListener(async (args, state) => {
        const result = await this.driver.checkLANPort(this, args.port.id);
        return result;
      });
      
      lanCondition.registerArgumentAutocompleteListener(
        "port",
        async (query, args) => {
          return await this.driver.autocompleteNas(this, query);
        }
      );
      
      this.flowCardsRegistered = true;
    }
    
    // Initialize capabilities if they don't exist
    if (!this.hasCapability('cpu_usage')) {
      await this.addCapability('cpu_usage');
    }
    if (!this.hasCapability('ram_usage')) {
      await this.addCapability('ram_usage');
    }
    if (!this.hasCapability('storage_used')) {
      await this.addCapability('storage_used');
    }
    
    // Start polling intervals
    this.startPolling();
  }

  startPolling() {
    // Poll system stats every 10 seconds
    this.statsInterval = this.homey.setInterval(async () => {
      try {
        await this.driver.updateSystemStats(this);
      } catch (err) {
        this.error('Error polling system stats:', err);
      }
    }, 10000);
    
    // Initial checks
    this.driver.updateSystemStats(this).catch(err => {
      this.error('Initial system stats update failed:', err);
    });
  }

  async onAdded() {
    this.log('NAS has been added');
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('NAS settings were changed');
  }

  async onRenamed(name) {
    this.log('NAS was renamed');
  }

  async onDeleted() {
    this.log('NAS has been deleted');
    
    // Clear all intervals
    if (this.statsInterval) {
      this.homey.clearInterval(this.statsInterval);
    }
  }
};
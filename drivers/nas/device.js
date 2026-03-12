'use strict';

const Homey = require('homey');

module.exports = class NASDevice extends Homey.Device {

  async onInit() {
    this.log('NAS has been initialized');

    if (!this.hasCapability('button.reboot')) {
      await this.addCapability('button.reboot');
      await this.setCapabilityOptions('button.reboot', {
        maintenanceAction: true,
        title: {
          en: 'Reboot',
          nl: 'Opnieuw opstarten',
        },
        desc: {
          en: 'Reboots the NAS',
          nl: 'De NAS herstarten'
        }
      });
    }
    if (!this.hasCapability('button.shutdown')) {
      await this.addCapability('button.shutdown');
      await this.setCapabilityOptions('button.shutdown', {
        maintenanceAction: true,
        title: {
          en: 'Shutdown',
          nl: 'Afsluiten'
        },
        desc: {
          en: 'Shut down the NAS gracefully',
          nl: 'De NAS veilig afsluiten'
        }
      });
    }
    
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

      this.registerCapabilityListener('button.reboot', async () => {
        // Maintenance action button was pressed, return a promise
        try {
          await this.driver.reboot(this);
          return true;
        } catch (err) {
          this.error('Error rebooting NAS:', err);
          throw new Error('Failed to reboot NAS');
        }
      });

      this.registerCapabilityListener('button.shutdown', async () => {
        // Maintenance action button was pressed, return a promise
        try {
          await this.driver.shutdown(this);
          return true;
        } catch (err) {
          this.error('Error shutting down NAS:', err);
          throw new Error('Failed to shut down NAS');
        }
      });

      const enableAppAction = this.homey.flow.getActionCard("enable_app");
      const disableAppAction = this.homey.flow.getActionCard("disable_app");
      const appEnabledCondition = this.homey.flow.getConditionCard("app_enabled");

      enableAppAction.registerArgumentAutocompleteListener(
        "app",
        async (query, args) => {
          return await this.driver.autocompleteApp(this, query);
        }
      );

      disableAppAction.registerArgumentAutocompleteListener(
        "app",
        async (query, args) => {
          return await this.driver.autocompleteApp(this, query);
        }
      );

      appEnabledCondition.registerArgumentAutocompleteListener(
        "app",
        async (query, args) => {
          return await this.driver.autocompleteApp(this, query);
        }
      );

      disableAppAction.registerRunListener(async (args, state) => {
        const result = await this.driver.disableApp(this, args);
        return result;
      });

      enableAppAction.registerRunListener(async (args, state) => {
        const result = await this.driver.enableApp(this, args);
        return result;
      });

      appEnabledCondition.registerRunListener(async (args, state) => {
        const result = await this.driver.checkApp(this, args);
        return result;
      });
      
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
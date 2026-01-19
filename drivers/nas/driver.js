'use strict';

const Homey = require('homey');
const axios = require('axios');
const FormData = require('form-data');

module.exports = class NASDriver extends Homey.Driver {

  async checkLANPort(device, lanInterface) {
    try {
      const sid = await device.getStoreValue('sid');
      const nasurl = await this.getWorkingUrl(device);
      const url = `${nasurl}portal/apis/information/sysinfo.cgi?sid=${sid}&act=net`;
      const res = await axios.get(url, { timeout: 7000 });
      const data = res.data;
      const result = data.netif.find(iface => iface.name.toLowerCase().includes(lanInterface.toLowerCase()))
      return result?.status === true;
    } catch (err) {
      this.error("Failed checking LAN port", err);
      return false;
    }
  }

  async getWorkingUrl(device) {
    try {
      const cloudId = await device.getStoreValue('cloudid');
      const lastWorkingUrl = await device.getStoreValue('url');
      const lastUrlCheck = await device.getStoreValue('last_url_check') || 0;
      const now = Date.now();
      
      // Try the last working URL first (quick check)
      if (lastWorkingUrl) {
        try {
          const testUrl = `${lastWorkingUrl}portal/resources/images/favicon.ico`;
          const response = await axios.get(testUrl, { timeout: 3000 });
          if (response.status === 200) {
            // Set device as available if it was unavailable
            if (!device.getAvailable()) {
              await device.setAvailable();
            }
            return lastWorkingUrl;
          }
        } catch (err) {
          // Check if blocked by ADM Defender (403)
          if (err.response?.status === 403) {
            this.log('Blocked by ADM Defender (403)');
            await device.setUnavailable("Homey is blocked by the ADM Defender. Remove Homey's IP from the ADM Defender blocklist.");
            throw new Error('ADM_DEFENDER_BLOCK');
          }
          this.log(`Last working URL failed: ${lastWorkingUrl} - ${err.code || err.message}`);
        }
      }
      
      // If last URL failed or it's time for periodic check (every 10 minutes)
      if (now - lastUrlCheck > 600000 || !lastWorkingUrl) {
        this.log('Finding new working URL for NAS');
        const ezcresult = await this.fetchNasApiResult(cloudId);
        
        if (ezcresult === 'invalid' || !ezcresult) {
          await device.setUnavailable("NAS is unreachable. Is it connected to the network?");
          throw new Error('NAS_UNREACHABLE');
        }
        
        const { workingUrl } = ezcresult;
        await device.setStoreValue('url', workingUrl);
        await device.setStoreValue('last_url_check', now);
        
        // Set device as available
        if (!device.getAvailable()) {
          await device.setAvailable();
        }
        
        return workingUrl;
      }
      
      return lastWorkingUrl;
    } catch (err) {
      // Only log if it's not one of our handled errors
      if (err.message !== 'ADM_DEFENDER_BLOCK' && err.message !== 'NAS_UNREACHABLE') {
        this.error("Unexpected error getting working URL:", err.message);
      }
      
      // Only set unavailable if not already set by specific error handlers
      if (err.response?.status !== 403 && err.message !== 'NAS_UNREACHABLE' && device.getAvailable()) {
        await device.setUnavailable("NAS is unreachable. Is it connected to the network?");
      }
      throw err;
    }
  }

  async credentialCheck(device) {
    try {
      const username = await device.getStoreValue('username');
      const password = await device.getStoreValue('password');
      const formData = new FormData();
      formData.append('account', username);
      formData.append('password', password);
      formData.append('two-step-auth', 'true');
      formData.append('stay', 'yes');
      const url = await device.getStoreValue('url');
      const response = await axios.post(`${url}portal/apis/login.cgi?act=login`, formData);
      if (response.data.error_code === 5001) {
        return false;
      }
      return true;
    } catch (err) {
      this.error("Credential check failed:", err);
      return false;
    }
  }

  async autocompleteNas(device, lanInterface) {
    try {
      const sid = await device.getStoreValue('sid');
      const nasurl = await this.getWorkingUrl(device);
      const url = `${nasurl}portal/apis/information/sysinfo.cgi?sid=${sid}&act=net`;
      const res = await axios.get(url, { timeout: 7000 });
      const data = res.data;
      const results = data.netif
        .filter(iface => iface.name.toLowerCase().includes(lanInterface.toLowerCase()))
        .map(iface => ({
          name: iface.name,
          description: iface.status ? "Connected" : "Disconnected",
          id: iface.name
        }));
      return results;
    } catch (err) {
      this.error("Fetching LAN interface list from NAS resulted in an error:", err);
      return [];
    }
  }

  async onInit() {
    try { 
      this.log('NAS driver init');
    } catch (err) {
      this.error("Error during NAS driver initialization:", err);
    }
  }

  async onPairListDevices() {
    return [];
  }

  onPair(session) {
    let tempCloudId;
    let tempUrl;
    let urlSearchTimeout;
    
    session.setHandler("cloudid", async (data) => {
      try {
        const cloudId = data.cloudid;
        tempCloudId = cloudId;
        
        // Start the URL search asynchronously
        this.findWorkingUrl(cloudId, session).then(result => {
          if (result === 'invalid') {
            session.emit('url_result', { status: 'invalid' });
          } else if (result) {
            tempUrl = result;
            session.emit('url_result', { status: 'success', url: result });
          } else {
            session.emit('url_result', { status: 'error' });
          }
        }).catch(err => {
          this.error("Error finding working URL:", err);
          session.emit('url_result', { status: 'error' });
        });
        
        // Return immediately to prevent timeout
        return 'searching';
      } catch (err) {
        this.error("Pairing failed:", err.message);
        return 'connecterror';
      }
    });
    
    session.setHandler("auth", async (data) => {
      try {
        const username = data.username;
        const password = data.password;
        const formData = new FormData();
        formData.append('account', username);
        formData.append('password', password);
        formData.append('two-step-auth', 'true');
        formData.append('stay', 'yes');
        const url = data.url;
        const response = await axios.post(`${url}portal/apis/login.cgi?act=login`, formData);
        
        if (response.data.error_code === 5001) {
          return 'invalid';
        }
        
        this.log(response.data.sid);
        return response.data.sid;
      } catch (error) {
        if (error.response?.status === 403) {
          return 'blocked';
        }
        this.error('Login error:', error);
        return 'autherror';
      }
    });
    
    session.setHandler("list_devices", async () => {
      // Check if device already exists
      const devices = this.getDevices();
      const existingDevice = devices.find(device => {
        const deviceCloudId = device.getData().cloudid;
        return deviceCloudId === tempCloudId;
      });
      
      if (existingDevice) {
        throw new Error('This NAS is already added to Homey');
      }
      
      return [];
    });
  }

  async findWorkingUrl(cloudId, session) {
    try {
      const result = await this.fetchApiResultFromEzconnect(cloudId);
      const urlsToTry = [];

      // lan access
      if (Array.isArray(result.lan_ips_http)) {
        urlsToTry.push(...result.lan_ips_http.map(ip => ({
          url: `${ip}portal/resources/images/favicon.ico`,
          type: 'LAN'
        })));
      }

      // ddns myasustor
      urlsToTry.push({
        url: `http://${cloudId}.myasustor.com:8000/portal/resources/images/favicon.ico`,
        type: 'DDNS'
      });

      // public wan ip
      if (result.wan_ip_http) {
        urlsToTry.push({
          url: `${result.wan_ip_http}portal/resources/images/favicon.ico`,
          type: 'WAN'
        });
      }

      // cloud relay (webrelay)
      if (result.relay_url) {
        urlsToTry.push({
          url: `${result.relay_url}portal/resources/images/favicon.ico`,
          type: 'Relay'
        });
      }

      if (result.errno === 2) {
        return "invalid";
      }

      // Try all URLs in parallel with individual timeouts
      const urlPromises = urlsToTry.map(async ({ url, type }) => {
        try {
          session.emit('url_test', { type, status: 'testing' });
          const response = await axios.get(url, { timeout: 5000 });
          if (response.status === 200) {
            this.log(`Working NAS URL (${type}): ${url}`);
            session.emit('url_test', { type, status: 'success' });
            return url.replace('portal/resources/images/favicon.ico', '');
          }
        } catch (err) {
          this.log(`Failed URL (${type}): ${url} - ${err.message}`);
          session.emit('url_test', { type, status: 'failed' });
        }
        return null;
      });

      // Wait for the first successful response
      const results = await Promise.all(urlPromises);
      const workingUrl = results.find(url => url !== null);

      if (!workingUrl) {
        throw new Error("No reachable NAS address found.");
      }

      return workingUrl;
    } catch (err) {
      this.error("Error in findWorkingUrl:", err);
      throw err;
    }
  }

  async fetchNasApiResult(cloudId) {
    const result = await this.fetchApiResultFromEzconnect(cloudId);
    const urlsToTry = [];

    // lan access
    if (Array.isArray(result.lan_ips_http)) {
      urlsToTry.push(...result.lan_ips_http.map(ip => `${ip}portal/resources/images/favicon.ico`));
    }

    // ddns myasustor
    urlsToTry.push(`http://${cloudId}.myasustor.com:8000/portal/resources/images/favicon.ico`);

    // public wan ip
    if (result.wan_ip_http) {
      urlsToTry.push(`${result.wan_ip_http}portal/resources/images/favicon.ico`);
    }

    // cloud relay (webrelay)
    if (result.relay_url) {
      urlsToTry.push(`${result.relay_url}portal/resources/images/favicon.ico`);
    }

    if (result.errno === 2) {
      return "invalid";
    }

    for (const testUrl of urlsToTry) {
      try {
        const response = await axios.get(testUrl, { timeout: 5000 });
        if (response.status === 200) {
          this.log(`Working NAS URL: ${testUrl}`);
          return {
            workingUrl: testUrl.replace('portal/resources/images/favicon.ico', ''),
            result
          };
        }
      } catch (err) {
        this.log(`Failed URL: ${testUrl} - ${err.message}`);
      }
    }

    throw new Error("No reachable NAS address found.");
  }

  async fetchApiResultFromEzconnect(cloudId) {
    try {
      this.log('Fetching data from EZConnect.to');
      const url = `https://${cloudId}.ezconnect.to/`;
      const res = await axios.get(url, { timeout: 7000 });
      const html = res.data;

      const match = html.match(/AS\.API\.apiResult\s*=\s*JSON\.parse\('([^']+)'/);
      if (!match) throw new Error("apiResult not found in ezconnect HTML");
      const jsonStr = match[1];
      return JSON.parse(jsonStr);
    } catch (e) {
      this.error("Error parsing apiResult JSON", e);
      throw e;
    }
  }

  async updateSystemStats(device) {
    try {
      const sid = await device.getStoreValue('sid');
      const nasurl = await this.getWorkingUrl(device);
      
      // Get CPU, RAM stats
      const actUrl = `${nasurl}portal/apis/activityMonitor/act.cgi?sid=${sid}&act=list`;
      const actRes = await axios.get(actUrl, { timeout: 7000 });
      
      if (!actRes.data) {
        this.error("No data received from activity monitor");
        return;
      }
      
      // Check for authentication errors (256, 5000, 5001)
      if (actRes.data.error_code === 256 || actRes.data.error_code === 5000 || actRes.data.error_code === 5001 || actRes.data.error_code === 5053) {
        this.log("Session expired (error code: " + actRes.data.error_code + "), re-logging in");
        await this.nasLogin(device);
        return;
      }
      
      if (!actRes.data.success) {
        this.error("Activity monitor request failed with error code:", actRes.data.error_code);
        return;
      }
      
      const data = actRes.data;
      
      // Calculate average CPU usage
      if (data.cpus && Array.isArray(data.cpus) && data.cpus.length > 0) {
        const cpuUsage = data.cpus.reduce((sum, cpu) => sum + cpu.usage, 0) / data.cpus.length;
        await device.setCapabilityValue('cpu_usage', Math.round(cpuUsage));
      } else {
        this.error("CPU data not available or invalid format");
      }
      
      // Calculate RAM usage percentage
      if (data.memtotal && data.memused !== undefined) {
        const memcached = data.memcached || 0;
        const membuffer = data.membuffer || 0;
        const ramUsagePercent = ((data.memused - memcached - membuffer) / data.memtotal) * 100;
        await device.setCapabilityValue('ram_usage', Math.round(ramUsagePercent));
      } else {
        this.error("RAM data not available or invalid format");
      }
      
      // Get storage stats
      const volUrl = `${nasurl}portal/apis/storageManager/volume.cgi?sid=${sid}&act=list`;
      const volRes = await axios.get(volUrl, { timeout: 7000 });
      
      if (volRes.data && volRes.data.success && volRes.data.volumes && Array.isArray(volRes.data.volumes)) {
        let totalUsed = 0;
        let totalCapacity = 0;
        
        volRes.data.volumes.forEach(volume => {
          if (volume.used !== undefined && volume.capacity !== undefined) {
            totalUsed += volume.used;
            totalCapacity += volume.capacity;
          }
        });
        
        if (totalCapacity > 0) {
          const storageUsedPercent = (totalUsed / totalCapacity) * 100;
          await device.setCapabilityValue('storage_used', Math.round(storageUsedPercent));
        }
      } else {
        this.error("Storage data not available or invalid format");
      }
    } catch (err) {
      this.error("Failed updating system stats", err);
      // If it's a network error, try to get a new URL
      if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        this.log("Network error, will try to find new URL on next check");
      }
    }
  }

  async nasLogin(device){
    try {
      const username = await device.getStoreValue('username');
      const password = await device.getStoreValue('password');
      let url;
      
      try {
        url = await this.getWorkingUrl(device);
      } catch (err) {
        // getWorkingUrl already handled the error and set unavailable
        return false;
      }
      
      const formData = new FormData();
      formData.append('account', username);
      formData.append('password', password);
      formData.append('two-step-auth', 'true');
      formData.append('stay', 'yes');
      
      let response;
      try {
        response = await axios.post(`${url}portal/apis/login.cgi?act=login`, formData);
      } catch (err) {
        if (err.response?.status === 403) {
          this.log('Login blocked by ADM Defender (403)');
          await device.setUnavailable("Homey is blocked by the ADM Defender. Remove Homey's IP from the ADM Defender blocklist.");
          return false;
        }
        if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
          this.log(`Login failed: ${err.code}`);
          return false;
        }
        this.log('Login error:', err.message);
        return false;
      }
      
      if (response.data.error_code === 5001) {
        this.log('Login failed: Invalid credentials');
        return false;
      }
      
      if (response.data.error_code === 5000) {
        this.log('Login failed: Authentication error');
        return false;
      }
      
      if (!response.data.sid) {
        this.log('Login failed: No SID received');
        return false;
      }
      
      this.log('Re-login successful, new SID:', response.data.sid);
      await device.setStoreValue('sid', response.data.sid);
      
      // Set device as available if login was successful
      if (!device.getAvailable()) {
        await device.setAvailable();
      }
      
      return true;
    } catch (error) {
      this.error('Unexpected login error:', error.message);
      return false;
    }
  }
};
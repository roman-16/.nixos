{
  domain = "halerc.xyz";
  ntfyTopic = "homelab";

  ips = {
    apollo = "192.168.70.73";
    hass = "192.168.70.71";
    homelab = "192.168.70.70";
    trader = "192.168.70.74";
  };

  ports = {
    beszel = 8090;
    caddy = 8082;
    cloudflaredMetrics = 2000;
    gatus = 8080;
    homepage = 8083;
    ntfy = 2586;
    reboot = 8084;
  };
}

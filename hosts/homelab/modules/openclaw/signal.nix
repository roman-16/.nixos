{
  pkgs,
  signalAccount,
  signalCliPort,
  signalDataDir,
}: {
  systemd = {
    services.signal-cli = {
      after = ["network.target"];
      description = "signal-cli JSON-RPC daemon";
      wantedBy = ["multi-user.target"];

      serviceConfig = {
        ExecStart = "${pkgs.signal-cli}/bin/signal-cli --config ${signalDataDir} -a ${signalAccount} daemon --http=127.0.0.1:${toString signalCliPort} --receive-mode=on-start --send-read-receipts";
        Restart = "on-failure";
        RestartSec = 10;
        StateDirectory = "signal-cli";
      };
    };

    tmpfiles.rules = [
      "d ${signalDataDir} 0700 root root -"
    ];
  };
}

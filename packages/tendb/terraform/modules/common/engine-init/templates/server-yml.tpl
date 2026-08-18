server:
  verificationToken: "${token}"
  port: 2345

# Engine console, reached via platform tunnels (tendb ui). Bind host is
# platform-shaped: loopback where the tunnel reaches it (local; AWS's frozen
# template does the same), the private IP where it can't — IAP and Bastion
# tunnels dial the VM's NIC, never its loopback. Firewalls scope 2346 to the
# tunnel ranges only.
embeddedUI:
  enabled: ${ui_enabled}
  dockerImage: "${ui_image}"
  host: "${ui_host}"
  port: 2346

global:
  engine: postgres
  debug: false
  database:
    username: postgres
    dbname: postgres

poolManager:
  mountDir: /var/lib/dblab
  dataSubDir: data
  clonesMountSubDir: clones
  socketSubDir: sockets
  observerSubDir: observer
  preSnapshotSuffix: "_pre"
  selectedPool: ""

databaseContainer: &db_container
  dockerImage: "${clone_image}"
  containerConfig:
    "shm-size": ${shm_size}

# Per clone — every clone allocates shared_buffers (see the size presets).
databaseConfigs: &db_configs
  configs:
%{ if streaming_snapshots ~}
    # Clones inherit the sync target's subscription; without workers they can
    # never connect out and fight it for the publisher's replication slot.
    max_logical_replication_workers: "0"
%{ endif ~}
%{ for key, value in postgres_configs ~}
    ${key}: "${value}"
%{ endfor ~}

provision:
  <<: *db_container
  portPool:
    from: ${port_pool_from}
    to: ${port_pool_to}
  useSudo: false
  keepUserPasswords: false
  cloneAccessAddresses: "0.0.0.0" # default is loopback-only — clones must be reachable in-network

retrieval:
  refresh:
%{ if streaming_snapshots ~}
    timetable: ""
    skipStartRefresh: true
  jobs: # streaming mode: tendb-snapshotd snapshots the live sync target
    - logicalSnapshot
%{ else ~}
    timetable: "${refresh_cron}"
    skipStartRefresh: ${skip_start_refresh}
  jobs:
    - logicalDump
    - logicalRestore
    - logicalSnapshot
%{ endif ~}
  spec:
    logicalDump:
      options:
        <<: *db_container
        dumpLocation: "/var/lib/dblab/dblab_pool/dump"
        source:
          type: remote
          connection: # libpq sslmode defaults to prefer — TLS negotiates when offered
            dbname: ${db_name}
            host: ${db_host}
            port: ${db_port}
            username: ${db_user}
            password: "${db_pass}"
        databases: # only the app database — managed-Postgres roles can't dump system DBs
          ${db_name}: {}
        parallelJobs: ${dump_parallel_jobs}
%{ if length(exclude_extensions) > 0 ~}
        customOptions: # provider-proprietary extensions, not installable in stock Postgres
%{ for ext in exclude_extensions ~}
          - "--exclude-extension=${ext}"
%{ endfor ~}
%{ else ~}
        customOptions: []
%{ endif ~}
    logicalRestore:
      options:
        <<: *db_container
        dumpLocation: "/var/lib/dblab/dblab_pool/dump"
        parallelJobs: ${restore_parallel_jobs}
        <<: *db_configs
        queryPreprocessing:
          queryPath: ""
          maxParallelWorkers: 1
          inline: ""
        customOptions: # source-managed roles don't exist locally
          - "--no-tablespaces"
          - "--no-privileges"
          - "--no-owner"
          - "--exit-on-error"
        skipPolicies: true
    logicalSnapshot:
      options:
        <<: *db_configs
        preprocessingScript: ""
        dataPatching:
          <<: *db_container
          queryPreprocessing:
            queryPath: ""
            maxParallelWorkers: 1
            inline: ""

cloning:
  accessHost: "${access_host}"
  maxIdleMinutes: ${max_idle_minutes} # leaked-clone reaper; active consumers never idle
  protectionLeaseDurationMinutes: 1440
  protectionMaxDurationMinutes: 10080
  protectionExpiryWarningMinutes: 1440

diagnostic:
  logsRetentionDays: ${logs_retention_days}

platform:
  url: "https://postgres.ai/api/general"
  enableTelemetry: false

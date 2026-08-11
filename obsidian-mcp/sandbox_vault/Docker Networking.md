---
title: "Docker Networking"
tags:
  - infra/containers
  - reference
aliases: [Docker Nets, "container networking"]
created: 2024-01-05
updated: 2024-01-06T09:30:00
status: published
draft: false
pinned: true
score: 4.5
reviewer: null
nested:
  owner: alice
  deps:
    - bridge
    - overlay
# how the driver stack fits together
---
Docker networking uses a bridge driver by default. The overlay driver spans
multiple hosts and is what [[Kubernetes Ingress]] builds on.

See also [[projects/Alpha|the Alpha project]] and [[Missing Note]].

#infra/containers

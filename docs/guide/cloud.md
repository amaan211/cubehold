# Cloud servers

Connect a cloud account and cubehold creates the VM for you: the machine, its firewall and SSH key,
then the same setup as a [VPS](./vps). Supported: **Hetzner, DigitalOcean, Vultr, Linode and
AWS**.

## Connect an account

**Hosts → Cloud accounts → Connect**. Pick the provider and follow the steps shown to create an
API token. For AWS, cubehold shows an IAM policy that lets it start, stop and delete only the machines
it created. Tokens are checked right away and stored encrypted with your password.

## Create a cloud server

**Hosts → Create a cloud server**. Choose a location near your players and a size. The table shows
each size's monthly price, what it would cost at 3 hours of play a day, and a suggested size for
your plan. Creating and setting up takes about a minute or two.

Everything cubehold creates carries an `cubehold-…` tag. cubehold never touches anything else in your account.

## Costs

The host card shows the hourly price, this month's cost so far, and last month's.

Providers bill differently when a VM is off:

| Provider | A stopped VM | So when idle, cubehold… |
| --- | --- | --- |
| AWS | Only the disk is billed | stops the VM |
| Hetzner, DigitalOcean, Vultr, Linode | Billed in full | saves it as a snapshot and deletes it |

A snapshot costs a few cents a month for a small server. Press **Start** on a server and cubehold
restores the VM from the snapshot (2 to 5 minutes), then deletes the snapshot.

## Turning the VM off when nobody plays

In a server's **Settings → Automation**, set **Stop when nobody is online**, then choose what
happens to the VM. Once every server on the VM has stopped for this reason, the VM goes down
after 2 minutes.

- The panel must be running for this, and to start the VM again.
- Wake on join cannot work while the VM is off; players ask you to press Start (or you get a
  Discord message and do it from your phone).
- A restored VM, and an AWS VM after a stop, usually gets a **new IP address**. The panel shows
  it, and a Discord message includes it.

## Removing

**Delete VM** on the host card deletes the VM, its disk, firewall, SSH key and snapshot. Check
your provider's console afterwards if you want to be sure nothing is left.

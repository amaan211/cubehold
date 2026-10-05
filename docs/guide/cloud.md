# Cloud servers

Connect a cloud account and cubehold creates the VM for you: the machine, its firewall and SSH key,
then the same setup as a [VPS](./vps). Supported: **Hetzner, DigitalOcean, Vultr, Linode and
AWS**. The provider bills you directly; cubehold shows what it costs.

## Connect an account

**Hosts → Cloud accounts → Connect an account**, or **New server → A new cloud server** when no
account is connected yet. Pick the provider and follow the steps shown to create an API token. For
AWS, cubehold shows an IAM policy that lets it start, stop and delete only the machines it created.
Tokens are checked right away and stored encrypted with your password.

## A new server on a new VM

**New server → Where it runs → A new cloud server**. Pick the account and a location near your
players; the size follows the memory you give the server (you can pick a bigger one). Fill in the
rest as for any server and press **Create the VM and server**. cubehold creates the VM, sets it up
(firewall, fail2ban, automatic security updates, SSH keys only) and then creates the Minecraft
server on it. This takes 3 to 6 minutes; the page opens the server when it is ready.

## A VM on its own

**Hosts → Create a cloud server** creates just the VM, sized for a number of players. Add servers
to it later from **New server**, or move existing ones to it.

Everything cubehold creates carries a `cubehold-…` tag or label. cubehold never touches anything
else in your account unless you tick it in the clean-up.

## Prices

Prices come from each provider's API (for AWS, its Price List API, or a US East estimate if the key
may not read it), before VAT or sales tax. Every price cubehold shows (on the New server page,
Create a cloud server, Getting a VPS and the host cards) is worked out the same way:

- **Always on** is the VM running all month, with what the provider bills on top: Hetzner's €0.50
  IPv4 address, and on AWS the public IPv4 address ($3.65) and the 30 GB disk ($2.40). On
  DigitalOcean, Vultr and Linode the address is included.
- A VM never costs more than its monthly price in a calendar month (AWS has no cap).
- **3 h a day** assumes 3 hours of play a day with the VM deleted and kept as a snapshot (stopped, on
  AWS) the rest of the time, which is the default (see below).
- Some plans have no monthly price and are billed by the hour all month (Linode's G8 Dedicated
  plans, Vultr's hourly plans); they cost more than plans with a monthly cap.

Providers bill differently when a VM is off:

| Provider | A stopped VM | So when idle, cubehold… |
| --- | --- | --- |
| AWS | Only the disk is billed | stops the VM |
| Hetzner, DigitalOcean, Vultr, Linode | Billed in full | saves it as a snapshot and deletes it |

A snapshot costs a few cents a month for a small server. Press **Start** on a server and cubehold
restores the VM from the snapshot (2 to 5 minutes), then deletes the snapshot.

## The cost page

**Costs** in the menu shows:

- this month so far, where it is heading if nothing changes, what the VMs cost per hour right now,
  and last month;
- the cost of each day, as a chart or a table;
- what you pay for: VM time, storage (snapshots, AWS disks) and IPv4 addresses;
- each VM's cost, hours and servers, including VMs deleted since;
- what is in each cloud account right now, asked from the provider: what your hosts use, anything
  cubehold left over (for example after a setup failed), and things cubehold did not make that
  cost money.

The figures are estimates from the providers' prices and the time each VM spent running, stopped
or saved. Your provider's invoice is what counts: it adds tax, traffic beyond the free allowance,
and any credits.

## When nobody plays

A server on a cloud VM is set up to save money from the start. In its **Settings → Automation**:

- **Stop the server when nobody is online**: after **15 minutes** with no players, the Minecraft
  server stops.
- **What happens to the VM**: 2 minutes after the last server on the VM has stopped this way:
  - **Delete it, keep a snapshot** (the default on Hetzner, DigitalOcean, Vultr and Linode, which
    bill a stopped VM in full): cubehold saves the VM's disk as a snapshot, then **deletes the VM**.
    You pay only for the snapshot until the server starts again. Your worlds are in the snapshot;
    **Start** makes a new VM from it in 2 to 5 minutes.
  - **Stop it, keep its disk** (the default on AWS, where a stopped VM costs only its disk): the VM
    is shut down but not deleted. **Start** boots it again in about a minute.
  - **Keep it running**: the VM stays on and keeps costing its full price.

Servers created before these defaults show a **Use the money-saving settings** button there.

- The panel must be running for this, and to start the VM again.
- A player joining cannot start the server while the VM is down; press **Start** in the panel (or
  from your phone, after a Discord message).
- After a restore, and on AWS after a stop, the VM usually has a **new IP address**. The server's
  Overview shows the current one, and a Discord message includes it.

## Removing

**Delete VM** on a host card deletes that VM, its disk, firewall, SSH key and snapshot.

To stop paying for everything at once, use **Costs → Clean up the cloud**. It deletes everything
cubehold made in your connected accounts: every cloud VM with its disk, snapshots, firewalls, SSH
keys and tags, and anything left over. **The Minecraft servers on those VMs are deleted with
them, worlds included**; to keep one, move it to this computer first (its **Settings** tab, under
**Host**). You type `delete` to confirm.

- Things cubehold did not make are left alone, unless you tick them in the list above the
  clean-up.
- Tick **Also disconnect the accounts** to make the panel forget the tokens too.
- When it finishes, cubehold asks the providers again and lists anything still there. The cost
  page keeps the month's costs of the deleted VMs.

use naia_server::{Server, ServerConfig, transport::udp};
use naia_shared::{WorldRefType, ReplicaRefWrapper, ReplicaDynRefWrapper, ComponentKind, ReplicatedComponent};
use shared_protocol::protocol;
use std::time::Duration;
use tokio::time::sleep;

// Simple entity type - just a u64 ID
type Entity = u64;

// Minimal world implementation for Naia
struct EmptyWorld;

impl WorldRefType<Entity> for EmptyWorld {
    fn entities(&self) -> Vec<Entity> {
        Vec::new()
    }

    fn has_entity(&self, _entity: &Entity) -> bool {
        false
    }

    fn has_component<R>(&self, _entity: &Entity) -> bool 
    where 
        R: ReplicatedComponent 
    {
        false
    }

    fn has_component_of_kind(&self, _entity: &Entity, _kind: &ComponentKind) -> bool {
        false
    }

    fn component<R>(&self, _entity: &Entity) -> Option<ReplicaRefWrapper<'_, R>> 
    where 
        R: ReplicatedComponent 
    {
        None
    }

    fn component_of_kind(&self, _entity: &Entity, _kind: &ComponentKind) -> Option<ReplicaDynRefWrapper<'_>> {
        None
    }
}

#[tokio::main]
async fn main() {
    env_logger::init();
    log::info!("Starting FPS Naia Server...");

    // Create protocol
    let protocol = protocol();

    // Create server socket (UDP)
    let server_addrs = udp::ServerAddrs::new(
        "0.0.0.0:14193"
            .parse()
            .expect("could not parse UDP address/port"),
        "127.0.0.1:14193"
            .parse()
            .expect("could not parse public address/port"),
        "http://127.0.0.1:14193",
    );
    let socket = udp::Socket::new(&server_addrs, None);

    // Create server
    let mut server = Server::new(ServerConfig::default(), protocol);
    server.listen(socket);

    log::info!("Server listening on UDP port 14193");

    // Main game loop
    let mut tick = 0u16;
    loop {
        // Receive all packets
        server.receive_all_packets();

        // Send all packets (with empty world for now)
        let world = EmptyWorld;
        server.send_all_packets(world);

        // Sleep to maintain tick rate (20 Hz = 50ms)
        sleep(Duration::from_millis(50)).await;
        
        tick = tick.wrapping_add(1);
        
        if tick % 20 == 0 {
            log::debug!("Server tick: {}", tick);
        }
    }
}

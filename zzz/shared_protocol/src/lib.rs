use std::time::Duration;
use naia_shared::{Protocol, Replicate, Property, Message};

// Components
#[derive(Replicate)]
pub struct Position {
    pub x: Property<f32>,
    pub y: Property<f32>,
    pub z: Property<f32>,
}

#[derive(Replicate)]
pub struct Rotation {
    pub yaw: Property<f32>,
    pub pitch: Property<f32>,
}

#[derive(Replicate)]
pub struct Velocity {
    pub x: Property<f32>,
    pub y: Property<f32>,
    pub z: Property<f32>,
}

#[derive(Replicate)]
pub struct Health {
    pub value: Property<u32>,
}

// Messages
#[derive(Message)]
pub struct PlayerInput {
    pub forward: i8,
    pub right: i8,
    pub jump: u8,
    pub ski: u8,
}

#[derive(Message)]
pub struct ShotEvent {
    pub target_id: Option<u64>,
    pub timestamp: u64,
}

pub fn protocol() -> Protocol {
    Protocol::builder()
        // Config
        .tick_interval(Duration::from_millis(50)) // 20 Hz
        // Channels
        .add_default_channels()
        // Messages
        .add_message::<PlayerInput>()
        .add_message::<ShotEvent>()
        // Components
        .add_component::<Position>()
        .add_component::<Rotation>()
        .add_component::<Velocity>()
        .add_component::<Health>()
        // Build Protocol
        .build()
}

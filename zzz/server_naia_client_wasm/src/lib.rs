use wasm_bindgen::prelude::*;
use client_app::NaiaClient;

#[wasm_bindgen]
pub struct NaiaWasmClient {
    inner: NaiaClient,
}

#[wasm_bindgen]
impl NaiaWasmClient {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        wasm_logger::init(wasm_logger::Config::default());
        Self {
            inner: NaiaClient::new(),
        }
    }

    pub fn connect(&mut self, server_url: &str) {
        self.inner.connect(server_url);
    }

    pub fn disconnect(&mut self) {
        self.inner.disconnect();
    }

    pub fn is_connected(&self) -> bool {
        self.inner.is_connected()
    }

    pub fn update(&mut self) {
        self.inner.update();
    }
}

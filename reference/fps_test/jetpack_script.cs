using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;
using TMPro;
using DG.Tweening;
public class jetpack_script : MonoBehaviour
{
    [SerializeField] private float maxFuel = 100f;
    [SerializeField] private float fuelCost = 25f;
    [SerializeField] private float fuelRegen = 15f;
    [SerializeField] private float minFuel = 10f;
    [SerializeField] private float thrustCost = 100f;
    [SerializeField] private float bounceMinPower = 50f;
    [SerializeField] private float thrustPower = 30f;
    [SerializeField] private float slamPower = 50f;
    [SerializeField] private float maxForwardAccelSpeed = 40f;
    public float force = 80f;
    public float horizontalForceMultiplier = 0.5f;
    public float JetPackAirControl;
    public ForceMode forceMode;
    private Rigidbody rb;
    private CharacterController cc;
    private float currentFuel;
    [SerializeField] TextMeshProUGUI fuelText;
    [SerializeField] TextMeshProUGUI dashText;
    [SerializeField] private Keybinds keybinds;
    [SerializeField] AudioClip dashSound;
    [SerializeField] AudioClip blinkSound;
    [SerializeField] AudioClip thrustSound;
    [SerializeField] AudioClip slamSound;
    [SerializeField] AudioSource whooshSource;
    [SerializeField] AudioSource jetSoundSource;
    [SerializeField] float jetSoundChangeRate = 10f;
    [SerializeField] float jetVolume = 0.5f;
    [SerializeField] ParticleSystem jetParticle;
    [SerializeField] ParticleSystem blinkParticle;
    public static int dashCharges = 0;
    [SerializeField] AudioSource audioSource;
    CC_Simplified _cc;
    RB_Controller rbc;
    float startingFOV;
    const string display = "{0:#}";
    bool canDash = true;
    bool canJet = true;
    public static jetpack_script instance;
    void Awake() {
        jetSoundSource.volume = 0.0f;
        dashText.text = "";
        instance = this;
    }
    void Start()
    {
        dashCharges = 0;
        rb = GetComponent<Rigidbody>();
        cc = GetComponent<CharacterController>();
        _cc = GetComponent<CC_Simplified>();
        rbc = GetComponent<RB_Controller>();
        currentFuel = maxFuel;
        startingFOV = Camera.main.fieldOfView;
    }
    public void AddDashCharges(int amount = 1)
    {
        dashCharges += amount;
        dashText.text = dashCharges.ToString();
    }

    public void AddFuel(float amount = 100f)
    {
        currentFuel += amount;
        currentFuel = Mathf.Clamp(currentFuel, 0, maxFuel);
    }

    void Update()
    {
        fuelText.GetComponent<TextMeshProUGUI>().text = string.Format(display, currentFuel);
        if (currentFuel < 10f)
        {
            fuelText.color = Color.red;
        }
        else
        {
            fuelText.color = new Color(1f, 1f, 1f, 150/255f);
        }

        whooshSource.volume = Mathf.Clamp(rb.linearVelocity.magnitude / 50f, 0, 0.25f);
        whooshSource.pitch = Mathf.Clamp(rb.linearVelocity.magnitude / 50f, 0, 3f);

        if (currentFuel <= 0.1f && canJet)
        {
            canJet = false;
        }
        else if (currentFuel >= minFuel && !canJet)
        {
            canJet = true;
        }

        if (Input.GetKeyDown(keybinds.keybindsProfile.bounceString) && dashCharges <= 0)
        {
            HUD_StaticReference.instance.NotEnoughNuggets();
        }
        
        if (Input.GetKeyDown(keybinds.keybindsProfile.bounceString) && canJet)
        if (canDash)
        if (dashCharges >= 1)
        {
            if (GlobalModifiers.activePack == 2)
                Blink();
            else
            if (GlobalModifiers.activePack == 3)
                Thrust();
            else
            if (GlobalModifiers.activePack == 4)
                Slam();
        }
    }

    void Slam()
    {
        canDash = false;
        DOVirtual.DelayedCall(1f, () => canDash = true);

        rb.AddForce(Vector3.down * slamPower, ForceMode.VelocityChange);
        
        audioSource.PlayOneShot(slamSound, 0.5f);
        UseNugCharge();
    }

    void Thrust()
    {
        canDash = false;
        DOVirtual.DelayedCall(1f, () => canDash = true);

        Vector3 thrustForce = Camera.main.transform.forward * thrustPower;

        Vector3 alignedWithVelocity = SplitVector(thrustForce, rb.linearVelocity, true);
        Vector3 lateral = SplitVector(thrustForce, rb.linearVelocity, false);

        Vector3 forwardForce = rb.linearVelocity.normalized * 75f - rb.linearVelocity;

        Vector3 finalForce = alignedWithVelocity.normalized * Mathf.Min(forwardForce.magnitude, alignedWithVelocity.magnitude);
        finalForce += lateral;

        rb.AddForce(finalForce, ForceMode.VelocityChange);
        
        audioSource.PlayOneShot(thrustSound, 0.5f);
        UseNugCharge();
    }

    void Blink()
    {
        canDash = false;
        DOVirtual.DelayedCall(1f, () => canDash = true);

        Vector3 targetPosition = transform.position;

        if (GlobalModifiers.blinkStyle == 0)
            targetPosition = transform.position + Camera.main.transform.forward * 50f;
        else if (GlobalModifiers.blinkStyle == 1)
            targetPosition = transform.position + rbc.GetInputAxes() * 50f;
        else
            targetPosition = transform.position + rb.linearVelocity.normalized * 50f;

        if (Physics.Raycast(transform.position, targetPosition - transform.position, out RaycastHit hit, 50f))
        {
            targetPosition = hit.point + Vector3.up * 0.5f;
        }

        RB_Controller.playerRB.DOMove(targetPosition, 0.1f);

        blinkParticle.Play();
        DOVirtual.DelayedCall(0.2f, () => blinkParticle.Stop());

        UseNugCharge();

        audioSource.PlayOneShot(blinkSound, 0.5f);
    }

    void OnCollisionEnter(Collision hit)
    {
        if (GlobalModifiers.activePack == 1)
        ThrustBounce(hit);
    }

    void OnCollisionStay(Collision hit)
    {
        if (GlobalModifiers.activePack == 1)
        ThrustBounce(hit);
    }

    void ThrustBounce(Collision hit)
    {
        if (hit.gameObject.CompareTag("World"))
        if (Input.GetKey(keybinds.keybindsProfile.bounceString) && dashCharges >= 1 && canDash)
        {
            canDash = false;
            DOVirtual.DelayedCall(1f, () => canDash = true);
            float thrustSpeedTreshold = 50f;

            if (rb.linearVelocity.magnitude >= thrustSpeedTreshold)
            {
                rb.linearVelocity = Camera.main.transform.forward * rb.linearVelocity.magnitude;
            }
            else
            {
                rb.linearVelocity = Camera.main.transform.forward * rb.linearVelocity.magnitude;
                float thurstMod = (thrustSpeedTreshold - rb.linearVelocity.magnitude) / thrustSpeedTreshold;
                rb.AddForce(Camera.main.transform.forward * bounceMinPower * thurstMod, ForceMode.VelocityChange);
            }
            
            UseNugCharge();

            // currentFuel -= thrustCost;

            if (dashSound != null)
            {
                audioSource.PlayOneShot(dashSound, 0.5f);
            }
            // Camera.main.DOFieldOfView(startingFOV - 2f, 0.5f)
            //     .OnComplete(() => Camera.main.DOFieldOfView(startingFOV, 0.5f));
        }
    }

    public void UseNugCharge(int amount = 1)
    {
        dashCharges -= amount;
        if (dashCharges > 0)
            dashText.text = dashCharges.ToString();
        else dashText.text = "";
    }

    void OnControllerColliderHit(ControllerColliderHit hit) 
    {
        if (hit.gameObject.CompareTag("World"))
        if (Input.GetKey(keybinds.keybindsProfile.bounceString) && dashCharges >= 1 && canDash)
        {
            canDash = false;
            DOVirtual.DelayedCall(1f, () => canDash = true);
            float thrustSpeedTreshold = 50f;

            if (cc.velocity.magnitude >= thrustSpeedTreshold)
            {
                _cc.ChangeVelocityDirection(Camera.main.transform.forward);
            }
            else
            {
                _cc.ChangeVelocityDirection(Camera.main.transform.forward);
                float thurstMod = (thrustSpeedTreshold - cc.velocity.magnitude) / thrustSpeedTreshold;
                _cc.SetKnockbackForce(Camera.main.transform.forward * bounceMinPower * thurstMod);
            }
            
            dashCharges -= 1;
            if (dashCharges > 0)
                dashText.text = dashCharges.ToString();
            else dashText.text = "";

            // currentFuel -= thrustCost;

            if (dashSound != null)
            {
                audioSource.PlayOneShot(dashSound, 0.5f);
            }
            // Camera.main.DOFieldOfView(startingFOV - 2f, 0.5f)
            //     .OnComplete(() => Camera.main.DOFieldOfView(startingFOV, 0.5f));
        }
    }
    
    public Vector3 JetMovement()
    {
        if (currentFuel > 0 && Input.GetKey(keybinds.keybindsProfile.jetString) && canJet)
        {
            Vector3 inputAxes = Vector3.zero;
            float controller_modifier = 0f;
            float controller_mult = 1f;

            if (rbc != null && rb.isKinematic == false)
            {
                controller_modifier = 10f * 8f * 80f / 48f;
                controller_mult = 62f / 80f;
                inputAxes = rbc.GetInputAxes();
            }
            else if (_cc != null)
            {
                controller_modifier = 10000f;
                inputAxes = _cc.GetInputAxes();
            }

            if (jetParticle.isPlaying == false)
                jetParticle.Play();
           
            float minFuel = 0f;
            float minPitch = 0.75f;
            float maxPitch = 0.65f;

            float pitchRange = maxPitch - minPitch;
            float normalizedFuel = (currentFuel - minFuel) / (maxFuel - minFuel);
            float pitch = maxPitch - (normalizedFuel * pitchRange);
            
            if (currentFuel / maxFuel > 0.5f)
                pitch = minPitch;

            jetSoundSource.pitch = pitch;

            jetSoundSource.volume += jetSoundChangeRate * Time.deltaTime;
            jetSoundSource.volume = Mathf.Clamp(jetSoundSource.volume, 0f, jetVolume);
            
            currentFuel -= fuelCost * Time.deltaTime;
            currentFuel = Mathf.Clamp(currentFuel, 0, maxFuel);
            
            float downJetsDirection = (Input.GetKey(keybinds.keybindsProfile.moveLeftString) && Input.GetKey(keybinds.keybindsProfile.moveRightString)) ? -1 : 1;
            float upJetsModifier = inputAxes != Vector3.zero ? GlobalModifiers.jetUpModifier : 1f;
            
            GameStats.jetTime += Time.deltaTime;

            Vector3 alignedWithVelocity = SplitVector(inputAxes * GlobalModifiers.jetLateralModifier, rb.linearVelocity, true);
            Vector3 lateral = SplitVector(inputAxes * GlobalModifiers.jetLateralModifier, rb.linearVelocity, false);

            if (rbc.HorizontalVelocityMagnitude() > maxForwardAccelSpeed)
            {
                alignedWithVelocity = Vector3.zero;
            }

            return (downJetsDirection *  upJetsModifier * Vector3.up 
            + (alignedWithVelocity + lateral))
            * GlobalModifiers.jetPower 
            / controller_modifier * controller_mult;
            // return Vector3.up * GlobalModifiers.jetPower / 10000 * Mathf.Clamp(currentFuel / 10, 0.5f, 1);
            // return Vector3.up * force / 10000 * Mathf.Clamp(currentFuel / 10, 0.5f, 1);
        }
        else
        {
            if (jetParticle.isPlaying == true)
                jetParticle.Stop();

            jetSoundSource.volume -= jetSoundChangeRate * Time.deltaTime;
            jetSoundSource.volume = Mathf.Clamp(jetSoundSource.volume, 0f, jetVolume);

            currentFuel += fuelRegen * Time.deltaTime;
            currentFuel = Mathf.Clamp(currentFuel, 0, maxFuel);
            return Vector3.zero;
        }
    }

    Vector3 SplitVector(Vector3 inputVector, Vector3 alignmentVector, bool forward)
    {
        Vector3 forwardVector = Vector3.Project(inputVector, alignmentVector);
        
        if (forward)
            return forwardVector;
        else
            return inputVector - forwardVector;
    }
}
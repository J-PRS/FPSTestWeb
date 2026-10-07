using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.SceneManagement;

public class GrappleUnreality : MonoBehaviour
{
    [SerializeField] private float radiusTreshold = 8f;
    private Transform grapplePoint;
    private bool anchored = true;
    private Rigidbody playerRB;
    public static GrappleUnreality instance;
    private Transform grappleProjectile;
    void Start()
    {
        instance = this;
        playerRB = GetComponent<Rigidbody>();
        Grapple.lineRenderer.positionCount = 0;
    }
    public void AnchorState(bool state)
    {
        anchored = state;
    }

    public void SetGrappleProjectile(Transform projectile)
    {
        Grapple.lineRenderer.positionCount = 2;
        grappleProjectile = projectile;
    }

    public void DestroyGrapleProjectile()
    {
        if (grappleProjectile != null)
            grappleProjectile.GetComponent<ProjectileController>().Explode();
    }

    public void SetGrapplePoint(Transform point)
    {
        grapplePoint = point;

        if (grapplePoint == null)
        {
            Grapple.lineRenderer.positionCount = 0;
            anchored = false;
        }
        else
        {
            Grapple.lineRenderer.positionCount = 2;
            anchored = true;
        }
    }

    private void FixedUpdate()
    {
        if (!anchored || grapplePoint == null || grapplePoint == null)
            return;

        Vector3 radius = grapplePoint.position - transform.position;
        
        if (radius.magnitude < radiusTreshold)
            return;

        Vector3 plane = Vector3.Cross(radius, Vector3.forward).normalized;
        float angle = Vector3.Angle(radius, Vector3.forward);
        
        // Vector3 rotated = Quaternion.AngleAxis(angle, plane) * radius;
        
        // print(rotated);
        // print(Quaternion.AngleAxis(-angle, plane) * rotated);

        Vector3 velocity = Quaternion.AngleAxis(angle, plane) * playerRB.linearVelocity;
        float acceleration = Mathf.Pow(new Vector2(velocity.x, velocity.y).magnitude, 2) / radius.magnitude;

        // velocity.z = 10f;
        // print("VelZ - " + velocity.z);
        // print("Accel - " + Time.fixedDeltaTime * acceleration);
        velocity.z = Mathf.Max(velocity.z, Time.fixedDeltaTime * acceleration);
        playerRB.linearVelocity = Quaternion.AngleAxis(-angle, plane) * velocity;
    }

    private void DrawRopeToPoint(Vector3 point)
    {
        Grapple.lineRenderer.SetPosition(0, Camera.main.transform.position - Vector3.up);
        Grapple.lineRenderer.SetPosition(1, point);
    }

    void LateUpdate()
    {
        Vector3 finalDrawPoint = Vector3.zero;
        
        if (anchored && grapplePoint != null && grapplePoint != null)
            finalDrawPoint = grapplePoint.position;
        else if (grappleProjectile != null)
            finalDrawPoint = grappleProjectile.position;

        if (finalDrawPoint == Vector3.zero)
            return;
        
        if ( Grapple.lineRenderer.positionCount != 2)
            Grapple.lineRenderer.positionCount = 2;
        
        DrawRopeToPoint(finalDrawPoint);
    }

    public bool GrappleProjectileExists()
    {
        if (grappleProjectile == null)
            return false;
        else
            return true;
    }

    void Update()
    {
        if (Input.GetKey(RB_Controller.instance.keybinds.keybindsProfile.jumpString))
        {
            DestroyGrapleProjectile();
        }
    }

    // private void Update()
    // {
    //     if (Input.GetKeyDown(KeyCode.R))
    //     {
    //         // Reload the current scene
    //         Scene currentScene = SceneManager.GetActiveScene();
    //         SceneManager.LoadScene(currentScene.name);
    //     }

    //     if (Input.GetKeyDown(KeyCode.Space))
    //     {
    //         Vector3 jumpVector = RandomVector() * 50f;
    //         jumpVector.y = 50f;

    //         playerRB.AddForce(jumpVector, ForceMode.Impulse);
    //     }
    // }

    // private Vector3 RandomVector()
    // {
    //     return new Vector3(Random.Range(-1f, 1f), Random.Range(-1f, 1f), Random.Range(-1f, 1f)).normalized;
    // }
}

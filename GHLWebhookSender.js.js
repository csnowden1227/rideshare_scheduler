import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

public class GHLWebhookSender {

    public static void main(String[] args) {
        // Replace with your actual GHL Inbound Webhook URL
        String webhookUrl = "https://services.leadconnectorhq.com/hooks/YOUR_ID_HERE";

        // This matches your exact JSON structure
        // Note: The triple quotes (""") allow for multi-line strings in Java 15+
        String jsonPayload = """
            {
              "contact": {
                "id": "12345",
                "name": "John Doe",
                "email": "john@example.com",
                "phone": "+15555555555"
              }
            }
            """;

        // Initialize the HTTP Client
        HttpClient client = HttpClient.newHttpClient();

        // Build the request
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(webhookUrl))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(jsonPayload))
                .build();

        // Send and handle the response
        try {
            System.out.println("Sending data to GHL...");
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
            
            System.out.println("Response Status Code: " + response.statusCode());
            System.out.println("Response Body: " + response.body());
            
            if (response.statusCode() == 200 || response.statusCode() == 201) {
                System.out.println("Success! Check your GHL Workflow 'Recent History'.");
            } else {
                System.out.println("Error: Something went wrong on the GHL side.");
            }
        } catch (Exception e) {
            System.err.println("Failed to connect to GHL. Check your internet or URL.");
            e.printStackTrace();
        }
    }
}